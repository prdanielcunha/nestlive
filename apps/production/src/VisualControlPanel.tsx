import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandResult } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import {
  useLiveCueCoordinator,
  type ArmedVisualCue
} from './LiveCueCoordinator';

type Controller = ReturnType<typeof useLiveNode>;

interface VisualClip {
  id: string;
  name: string;
  connected: boolean;
  empty: boolean;
}

interface VisualLayer {
  id: string;
  name: string;
  clips: VisualClip[];
  groupId?: string;
  groupName?: string;
}

interface VisualOutput {
  id: string;
  name: string;
}

interface VisualLayerSection {
  id: string;
  name: string;
  grouped: boolean;
  layers: VisualLayer[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function parameterValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return value;
  const record = asRecord(value);
  if (record && 'value' in record) {
    return parameterValue(record.value, depth + 1);
  }
  return value;
}

function displayText(value: unknown, fallback = ''): string {
  const unwrapped = parameterValue(value);
  if (typeof unwrapped === 'string') {
    const text = unwrapped.trim();
    return text || fallback;
  }
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') {
    return String(unwrapped);
  }

  const record = asRecord(unwrapped);
  if (record) {
    for (const key of ['display_name', 'displayName', 'name', 'title', 'label', 'text']) {
      if (!(key in record)) continue;
      const text = displayText(record[key], '');
      if (text) return text;
    }
  }

  return fallback;
}

function entityId(value: unknown): string {
  const unwrapped = parameterValue(value);
  if (typeof unwrapped === 'string' || typeof unwrapped === 'number') {
    return String(unwrapped);
  }
  const record = asRecord(unwrapped);
  if (!record) return '';
  return entityId(record.id ?? record.uuid ?? record.identifier ?? '');
}

function booleanValue(value: unknown): boolean {
  const unwrapped = parameterValue(value);
  if (typeof unwrapped === 'string') {
    return ['true', '1', 'on', 'yes'].includes(unwrapped.toLowerCase());
  }
  return Boolean(unwrapped);
}

function collectionValue(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const candidate = parameterValue(record[key]);
    if (Array.isArray(candidate)) return candidate;
    const candidateRecord = asRecord(candidate);
    if (candidateRecord) return Object.values(candidateRecord);
  }
  return [];
}

function domSafeId(prefix: string, value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${prefix}-${safe || 'item'}`;
}

function clipNameFromRecord(clip: Record<string, unknown>): string {
  return displayText(
    clip.display_name,
    displayText(
      clip.displayName,
      displayText(clip.name, '')
    )
  );
}

function visibleLayerClips(clips: VisualClip[]): VisualClip[] {
  let emptyCount = 0;
  return clips.filter(clip => {
    if (!clip.empty) return true;
    emptyCount += 1;
    return emptyCount <= 4;
  });
}

function normalizeLayer(
  layerValue: unknown,
  group?: { id: string; name: string }
): VisualLayer | null {
  const layer = asRecord(layerValue);
  if (!layer) return null;

  const id = entityId(layer.id);
  if (!id) return null;

  const clips = collectionValue(layer, ['clips'])
    .map(clipValue => {
      const clip = asRecord(clipValue);
      if (!clip) return null;
      const clipId = entityId(clip.id);
      if (!clipId) return null;
      const clipName = clipNameFromRecord(clip);
      return {
        id: clipId,
        name: clipName || 'Clip',
        connected: booleanValue(clip.connected),
        empty: !clipName
      } satisfies VisualClip;
    })
    .filter((clip): clip is VisualClip => Boolean(clip));

  const ownGroupValue =
    layer.layergroup ??
    layer.layerGroup ??
    layer.layer_group ??
    layer.group ??
    layer.layergroup_id ??
    layer.layerGroupId ??
    layer.layer_group_id ??
    layer.group_id ??
    layer.groupId ??
    layer.layergroupid ??
    layer.groupid ??
    layer.parentGroup ??
    layer.parent_group;
  const ownGroupRecord = asRecord(ownGroupValue);
  const ownGroupId = entityId(ownGroupValue);
  const ownGroupName = ownGroupRecord
    ? displayText(
        ownGroupRecord.display_name,
        displayText(
          ownGroupRecord.displayName,
          displayText(ownGroupRecord.name, '')
        )
      )
    : '';

  return {
    id,
    name: displayText(
      layer.display_name,
      displayText(
        layer.displayName,
        displayText(layer.name, 'Layer')
      )
    ),
    clips,
    groupId: group?.id || ownGroupId || undefined,
    groupName: group?.name || ownGroupName || undefined
  };
}

function normalizeComposition(value: unknown): VisualLayer[] {
  const composition = asRecord(value);
  if (!composition) return [];

  const rawGroups = collectionValue(
    composition,
    ['layergroups', 'layerGroups', 'layer_groups', 'groups']
  );
  const groupByLayerId = new Map<string, { id: string; name: string }>();
  const groupByLayerIndex = new Map<string, { id: string; name: string }>();
  const embeddedGroupLayers: Array<{ layer: unknown; group: { id: string; name: string } }> = [];

  rawGroups.forEach((groupValue, index) => {
    const groupRecord = asRecord(groupValue);
    if (!groupRecord) return;
    const group = {
      id: entityId(
        groupRecord.id ??
        groupRecord.layergroup_id ??
        groupRecord.layerGroupId ??
        groupRecord.group_id
      ) || `group-${index + 1}`,
      name: displayText(
        groupRecord.display_name,
        displayText(
          groupRecord.displayName,
          displayText(groupRecord.name, `Group ${index + 1}`)
        )
      )
    };
    const members = collectionValue(
      groupRecord,
      ['layers', 'layerIds', 'layer_ids', 'members', 'children', 'items']
    );
    members.forEach(layerValue => {
      const layerRecord = asRecord(layerValue);
      const layerId = entityId(
        layerRecord?.id ??
        layerRecord?.layer_id ??
        layerRecord?.layerId ??
        layerValue
      );
      if (layerId) groupByLayerId.set(layerId, group);

      const primitiveLayerIndex =
        typeof layerValue === 'number' || typeof layerValue === 'string'
          ? layerValue
          : undefined;
      const layerIndex = displayText(
        layerRecord?.index ??
        layerRecord?.position ??
        layerRecord?.layer_index ??
        primitiveLayerIndex,
        ''
      );
      if (layerIndex) groupByLayerIndex.set(layerIndex, group);
      if (layerRecord) embeddedGroupLayers.push({ layer: layerValue, group });
    });
  });

  const normalized: VisualLayer[] = [];
  const seen = new Set<string>();

  collectionValue(composition, ['layers']).forEach((layerValue, index) => {
    const layerRecord = asRecord(layerValue);
    const layerId = entityId(layerRecord?.id);
    const explicitGroup =
      layerId ? groupByLayerId.get(layerId) : undefined;
    const layerIndex = displayText(
      layerRecord?.index ??
      layerRecord?.position ??
      layerRecord?.layer_index ??
      index + 1,
      ''
    );
    const indexedGroup = layerIndex ? groupByLayerIndex.get(layerIndex) : undefined;
    const layer = normalizeLayer(layerValue, explicitGroup || indexedGroup);
    if (!layer || seen.has(layer.id)) return;
    seen.add(layer.id);
    normalized.push(layer);
  });

  for (const embedded of embeddedGroupLayers) {
    const layer = normalizeLayer(embedded.layer, embedded.group);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    normalized.push(layer);
  }

  return normalized;
}

function outputsFromResults(results: CommandResult[]): VisualOutput[] {
  const raw = results
    .flatMap(result => {
      const outputs = result.observedState?.outputs;
      return Array.isArray(outputs) ? outputs : [];
    })
    .filter(output => output && typeof output === 'object') as Array<Record<string, unknown>>;

  return raw
    .map(output => ({
      id: String(output.id || output.monitor_id || ''),
      name: displayText(
        output.display_name,
        displayText(
          output.displayName,
          displayText(output.name, displayText(output.id, 'Output'))
        )
      )
    }))
    .filter(output => output.id);
}

function compositionFromResults(results: CommandResult[]): unknown {
  for (const result of results) {
    const composition = result.observedState?.composition;
    if (composition && typeof composition === 'object') return composition;
  }
  return null;
}

export function VisualControlPanel({
  controller,
  actorId,
  liveSessionId
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
}) {
  const { t } = useTranslation();
  const cueCoordinator = useLiveCueCoordinator();
  const [busy, setBusy] = useState<string | null>(null);
  const [localComposition, setLocalComposition] = useState<unknown>(null);
  const [outputs, setOutputs] = useState<VisualOutput[]>([]);
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [clipThumbnails, setClipThumbnails] = useState<Record<string, string>>({});
  const [clipViewMode, setClipViewMode] = useState<'visual' | 'compact'>('visual');
  const [localArmedClip, setLocalArmedClip] = useState<ArmedVisualCue | null>(null);
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const outputDiscoveryProvider = useRef('');
  const lastSnapshotSignature = useRef('');
  const armedClip = cueCoordinator?.armedVisualCue || localArmedClip;
  const armVisualCue = cueCoordinator?.armVisualCue || setLocalArmedClip;
  const clearVisualCue = cueCoordinator?.clearVisualCue || (() => setLocalArmedClip(null));

  const provider = useMemo(
    () => (controller.nodeState?.providers || []).find(candidate =>
      (candidate.health === 'online' || candidate.health === 'degraded') &&
      candidate.capabilities.includes('visual.composition.read')
    ) || null,
    [controller.nodeState]
  );

  const observedComposition =
    provider?.observed?.composition && typeof provider.observed.composition === 'object'
      ? provider.observed.composition
      : null;
  const layers = normalizeComposition(localComposition || observedComposition);
  const activeClips = useMemo(
    () => layers.flatMap(layer =>
      layer.clips
        .filter(clip => clip.connected && !clip.empty)
        .map(clip => ({
          clipId: clip.id,
          clipName: clip.name,
          layerId: layer.id,
          layerName: layer.name
        }))
    ),
    [layers]
  );

  useEffect(() => {
    return () => {
      if (snapshotUrl) URL.revokeObjectURL(snapshotUrl);
    };
  }, [snapshotUrl]);

  // Automatically discover visual outputs once per provider. The operator should
  // see NOW without having to understand or manually query Resolume monitors.
  useEffect(() => {
    if (
      !provider ||
      !provider.capabilities.includes('visual.outputs.read') ||
      outputDiscoveryProvider.current === provider.providerId
    ) {
      return;
    }

    outputDiscoveryProvider.current = provider.providerId;
    let cancelled = false;

    void controller.executeCommand({
      capability: 'visual.outputs.read',
      payload: {},
      targetProviderIds: [provider.providerId],
      liveSessionId,
      actorId,
      safetyLevel: 'normal'
    }).then(results => {
      if (cancelled) return;
      const next = outputsFromResults(results);
      setOutputs(next);
      setSelectedOutputId(current => current || next[0]?.id || '');
    }).catch(() => {
      if (!cancelled) outputDiscoveryProvider.current = '';
    });

    return () => {
      cancelled = true;
    };
  }, [
    actorId,
    controller.executeCommand,
    liveSessionId,
    provider
  ]);

  const activeClipSignature = activeClips
    .map(clip => `${clip.layerId}:${clip.clipId}`)
    .join('|');

  const clipThumbnailSignature = layers
    .flatMap(layer => layer.clips.filter(clip => !clip.empty).map(clip => clip.id))
    .join('|');

  const layerSections = useMemo<VisualLayerSection[]>(() => {
    const sections: VisualLayerSection[] = [];
    const grouped = new Map<string, VisualLayerSection>();
    const ungrouped: VisualLayer[] = [];

    for (const layer of layers) {
      if (!layer.groupId) {
        ungrouped.push(layer);
        continue;
      }
      let section = grouped.get(layer.groupId);
      if (!section) {
        section = {
          id: layer.groupId,
          name: layer.groupName || layer.groupId,
          grouped: true,
          layers: []
        };
        grouped.set(layer.groupId, section);
        sections.push(section);
      }
      section.layers.push(layer);
    }

    if (ungrouped.length) {
      sections.push({
        id: 'ungrouped',
        name: t('visualControls.ungrouped'),
        grouped: false,
        layers: ungrouped
      });
    }

    return sections;
  }, [layers, t]);

  const navigationTargets = layerSections.flatMap(section => {
    const targets = section.grouped
      ? [{
          id: domSafeId('visual-group', section.id),
          label: section.name
        }]
      : [];
    return targets.concat(section.layers.map(layer => ({
      id: domSafeId('visual-layer', layer.id),
      label: section.grouped
        ? `${section.name} · ${layer.name}`
        : layer.name
    })));
  });

  useEffect(() => {
    let cancelled = false;
    const generatedUrls: string[] = [];

    setClipThumbnails(current => {
      Object.values(current).forEach(url => URL.revokeObjectURL(url));
      return {};
    });

    if (
      !provider ||
      !provider.capabilities.includes('visual.clip.thumbnail') ||
      !clipThumbnailSignature
    ) {
      return () => {
        cancelled = true;
      };
    }

    const clipIds = Array.from(new Set(
      layers.flatMap(layer =>
        layer.clips.filter(clip => !clip.empty).map(clip => clip.id)
      )
    ));

    void (async () => {
      for (let index = 0; index < clipIds.length && !cancelled; index += 6) {
        const batch = clipIds.slice(index, index + 6);
        const entries = await Promise.all(batch.map(async clipId => {
          try {
            const blob = await controller.fetchClipThumbnail(provider.providerId, clipId);
            if (!blob.size || cancelled) return null;
            const url = URL.createObjectURL(blob);
            generatedUrls.push(url);
            return [clipId, url] as const;
          } catch {
            return null;
          }
        }));

        if (cancelled) break;
        const nextEntries = entries.filter(
          (entry): entry is readonly [string, string] => Boolean(entry)
        );
        if (nextEntries.length) {
          setClipThumbnails(current => ({
            ...current,
            ...Object.fromEntries(nextEntries)
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      generatedUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [
    clipThumbnailSignature,
    controller.fetchClipThumbnail,
    provider?.providerId
  ]);

  // Snapshot only when the visual program actually changes (or output changes).
  // This keeps the left NOW preview fresh without turning health polling into a
  // high-bandwidth video stream.
  useEffect(() => {
    if (
      !provider ||
      !selectedOutputId ||
      !provider.capabilities.includes('visual.output.snapshot')
    ) {
      return;
    }

    const signature = `${provider.providerId}:${selectedOutputId}:${activeClipSignature}`;
    if (lastSnapshotSignature.current === signature) return;
    lastSnapshotSignature.current = signature;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void controller.fetchOutputSnapshot(
        provider.providerId,
        selectedOutputId,
        'jpeg'
      ).then(blob => {
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        setSnapshotUrl(current => {
          if (current) URL.revokeObjectURL(current);
          return nextUrl;
        });
      }).catch(() => {
        if (!cancelled) lastSnapshotSignature.current = '';
      });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeClipSignature,
    controller.fetchOutputSnapshot,
    provider,
    selectedOutputId
  ]);

  if (!provider) return null;
  const activeProvider = provider;

  async function execute(
    key: string,
    capability:
      | 'visual.composition.read'
      | 'visual.clip.trigger'
      | 'visual.layer.clear'
      | 'visual.composition.clear'
      | 'visual.outputs.read',
    payload: Record<string, unknown> = {},
    guarded = false
  ) {
    setBusy(key);
    try {
      const results = await controller.executeCommand({
        capability,
        payload,
        targetProviderIds: [activeProvider.providerId],
        liveSessionId,
        actorId,
        safetyLevel: guarded ? 'guarded' : 'normal',
        confirmed: guarded
      });
      const composition = compositionFromResults(results);
      if (composition) setLocalComposition(composition);
      return results;
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    await execute('refresh', 'visual.composition.read');
  }

  async function triggerClip(clipId: string) {
    const results = await execute(`clip:${clipId}`, 'visual.clip.trigger', { clipId });
    window.setTimeout(() => void refresh(), 120);
    if (selectedOutputId) {
      window.setTimeout(() => void refreshSnapshot(), 320);
    }
    return results;
  }

  async function takeArmedClip() {
    if (!armedClip) return;
    const results = await triggerClip(armedClip.clipId);
    if (results?.some(result => result.accepted)) {
      clearVisualCue();
    }
  }

  async function clearLayer(layerId: string) {
    await execute(`layer:${layerId}`, 'visual.layer.clear', { layerId });
    window.setTimeout(() => void refresh(), 120);
  }

  async function loadOutputs() {
    if (!activeProvider.capabilities.includes('visual.outputs.read')) return;
    const results = await execute('outputs', 'visual.outputs.read');
    const next = outputsFromResults(results || []);
    setOutputs(next);
    if (!selectedOutputId && next[0]) setSelectedOutputId(next[0].id);
  }

  async function refreshSnapshot() {
    const targetId = selectedOutputId || outputs[0]?.id;
    if (!targetId || !activeProvider.capabilities.includes('visual.output.snapshot')) return;
    setBusy('snapshot');
    try {
      const blob = await controller.fetchOutputSnapshot(
        activeProvider.providerId,
        targetId,
        'jpeg'
      );
      const nextUrl = URL.createObjectURL(blob);
      setSnapshotUrl(current => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    if (!clearAllArmed) {
      setClearAllArmed(true);
      window.setTimeout(() => setClearAllArmed(false), 4000);
      return;
    }
    setClearAllArmed(false);
    await execute('clear-all', 'visual.composition.clear', {}, true);
    window.setTimeout(() => void refresh(), 120);
  }

  function renderLayer(layer: VisualLayer) {
    const visibleClips = visibleLayerClips(layer.clips);
    return (
      <article
        key={layer.id}
        id={domSafeId('visual-layer', layer.id)}
        className="visual-layer"
      >
        <header>
          <div className="visual-layer-heading">
            <small>{t('visualControls.layer')}</small>
            <strong>{layer.name}</strong>
          </div>
          <button
            disabled={busy !== null}
            onClick={() => void clearLayer(layer.id)}
          >
            {t('visualControls.clearLayer')}
          </button>
        </header>
        <div className="visual-clip-grid">
          {visibleClips.map(clip => {
            if (clip.empty) {
              return (
                <div
                  key={clip.id}
                  className="visual-clip-slot-empty"
                  aria-label={t('visualControls.emptySlot')}
                >
                  <span aria-hidden="true">+</span>
                  <small>{t('visualControls.emptySlot')}</small>
                </div>
              );
            }

            const thumbnailUrl = clipThumbnails[clip.id];
            return (
              <button
                key={clip.id}
                className={[
                  clip.connected ? 'active' : '',
                  armedClip?.clipId === clip.id ? 'armed' : ''
                ].filter(Boolean).join(' ')}
                disabled={busy !== null}
                onClick={() => armVisualCue({
                  providerId: activeProvider.providerId,
                  clipId: clip.id,
                  clipName: clip.name,
                  layerId: layer.id,
                  layerName: layer.name
                })}
                title={clip.name}
              >
                <span
                  className={`visual-clip-thumbnail${thumbnailUrl ? '' : ' empty'}`}
                  aria-hidden="true"
                >
                  {thumbnailUrl && (
                    <img src={thumbnailUrl} alt="" loading="lazy" />
                  )}
                </span>
                <span className="visual-clip-meta">
                  <span className="visual-clip-title">{clip.name}</span>
                  <small>
                    {armedClip?.clipId === clip.id
                      ? t('visualControls.next')
                      : clip.connected
                        ? t('visualControls.live')
                        : t('visualControls.ready')}
                  </small>
                </span>
              </button>
            );
          })}
          {!visibleClips.length && (
            <small className="visual-empty">{t('visualControls.noClips')}</small>
          )}
        </div>
      </article>
    );
  }

  const selectedOutputName =
    outputs.find(output => output.id === selectedOutputId)?.name ||
    outputs[0]?.name ||
    t('visualControls.outputAuto');
  const armedLayer = armedClip
    ? layers.find(layer => layer.id === armedClip.layerId) || null
    : null;
  const armedGroupName =
    armedLayer?.groupName || t('visualControls.ungrouped');

  return (
    <section className={`visual-control-panel${armedClip ? ' has-take-dock' : ''}`}>
      <div className="visual-control-head">
        <div>
          <span className="eyebrow">{t('visualControls.kicker')}</span>
          <h2>{t('visualControls.title')}</h2>
          <p>{t('visualControls.description')}</p>
        </div>
        <div className="visual-control-actions">
          <button
            className="secondary"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            {busy === 'refresh' ? '…' : t('visualControls.refresh')}
          </button>
          <button
            className={clearAllArmed ? 'danger-armed' : 'secondary'}
            disabled={busy !== null}
            onClick={() => void clearAll()}
          >
            {clearAllArmed ? t('visualControls.confirmClearAll') : t('visualControls.clearAll')}
          </button>
        </div>
      </div>



      <div className="visual-now-next" aria-label={t('visualControls.nowNext')}>
        <section className="visual-cue visual-cue-live">
          <header>
            <span className="deck-live-dot" />
            <div>
              <strong>{t('visualControls.current')}</strong>
              <small>{t('visualControls.program')}</small>
            </div>
          </header>
          <div className="visual-cue-body">
            {snapshotUrl ? (
              <img src={snapshotUrl} alt={t('visualControls.outputSnapshotAlt')} />
            ) : activeClips.length ? (
              <div className="visual-current-list">
                {activeClips.slice(0, 4).map(clip => (
                  <div key={clip.clipId}>
                    <small>{clip.layerName}</small>
                    <strong>{clip.clipName}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="visual-cue-empty">
                <span>{t('visualControls.nothingLive')}</span>
              </div>
            )}
          </div>
        </section>

        <div className="deck-flow" aria-hidden="true"><span>→</span></div>

        <section className="visual-cue visual-cue-next">
          <header>
            <div>
              <strong>{t('visualControls.next')}</strong>
              <small>{t('visualControls.preview')}</small>
            </div>
          </header>
          <div className="visual-cue-body">
            {armedClip ? (
              <div className="visual-armed-cue">
                <small>{armedClip.layerName}</small>
                <strong>{armedClip.clipName}</strong>
                <span>{t('visualControls.armed')}</span>
              </div>
            ) : (
              <div className="visual-cue-empty">
                <span>{t('visualControls.chooseClip')}</span>
              </div>
            )}
          </div>
          <footer>
            <button
              className="deck-take"
              disabled={!armedClip || busy !== null}
              onClick={() => void takeArmedClip()}
            >
              {busy?.startsWith('clip:') ? '…' : t('visualControls.take')} →
            </button>
          </footer>
        </section>
      </div>

      {activeProvider.capabilities.includes('visual.outputs.read') && (
        <div className="visual-output-strip">
          <div className="visual-output-copy">
            <small>{t('visualControls.outputPreview')}</small>
            <strong>{t('visualControls.outputPreviewDescription')}</strong>
          </div>
          <div className="visual-output-actions">
            {outputs.length > 1 ? (
              <select
                value={selectedOutputId}
                onChange={event => setSelectedOutputId(event.target.value)}
                aria-label={t('visualControls.output')}
              >
                <option value="">{t('visualControls.chooseOutput')}</option>
                {outputs.map(output => (
                  <option key={output.id} value={output.id}>{output.name}</option>
                ))}
              </select>
            ) : (
              <span className="visual-output-selected">
                {outputs[0]?.name || t('visualControls.outputAuto')}
              </span>
            )}
            <button
              className="secondary"
              disabled={busy !== null}
              onClick={() => void loadOutputs()}
            >
              {t('visualControls.outputs')}
            </button>
            <button
              className="primary"
              disabled={
                busy !== null ||
                !selectedOutputId ||
                !activeProvider.capabilities.includes('visual.output.snapshot')
              }
              onClick={() => void refreshSnapshot()}
            >
              {busy === 'snapshot' ? '…' : t('visualControls.snapshot')}
            </button>
          </div>
        </div>
      )}

      {layers.length ? (
        <>
          <div className="visual-library-toolbar">
            <div className="visual-library-toolbar-copy">
              <small>{t('visualControls.libraryView')}</small>
            </div>
            <div
              className="visual-library-view-switch"
              role="group"
              aria-label={t('visualControls.libraryView')}
            >
              <button
                type="button"
                className={clipViewMode === 'visual' ? 'active' : ''}
                aria-pressed={clipViewMode === 'visual'}
                onClick={() => setClipViewMode('visual')}
              >
                {t('visualControls.visualView')}
              </button>
              <button
                type="button"
                className={clipViewMode === 'compact' ? 'active' : ''}
                aria-pressed={clipViewMode === 'compact'}
                onClick={() => setClipViewMode('compact')}
              >
                {t('visualControls.compactView')}
              </button>
            </div>
          </div>
          <nav
            className="visual-library-nav"
            aria-label={t('visualControls.quickNavigation')}
          >
            <small>{t('visualControls.quickNavigation')}</small>
            <div>
              {navigationTargets.map(target => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => document.getElementById(target.id)?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                  })}
                >
                  {target.label}
                </button>
              ))}
            </div>
          </nav>
          <div className={`visual-layer-list ${clipViewMode === 'compact' ? 'compact' : 'visual'}`}>
          {layerSections.map(section => (
            <section
              key={section.id}
              id={domSafeId('visual-group', section.id)}
              className={`visual-layer-group${section.grouped ? '' : ' ungrouped'}`}
            >
              <header className="visual-layer-group-head">
                <div>
                  <small>{section.grouped
                    ? t('visualControls.group')
                    : t('visualControls.ungrouped')}
                  </small>
                  <strong>{section.name}</strong>
                </div>
                <span>{section.layers.length} {t('visualControls.layers')}</span>
              </header>
              <div className="visual-layer-group-layers">
                {section.layers.map(renderLayer)}
              </div>
            </section>
          ))}
          </div>
        </>
      ) : (
        <div className="visual-empty-state">
          <p>{t('visualControls.loadHint')}</p>
          <button className="primary" disabled={busy !== null} onClick={() => void refresh()}>
            {t('visualControls.loadComposition')}
          </button>
        </div>
      )}

      {armedClip && (
        <aside className="visual-take-dock" aria-live="polite">
          <div className="visual-take-dock-thumb" aria-hidden="true">
            {clipThumbnails[armedClip.clipId] ? (
              <img src={clipThumbnails[armedClip.clipId]} alt="" />
            ) : (
              <span>▶</span>
            )}
          </div>
          <div className="visual-take-dock-copy">
            <small>{t('visualControls.prepared')}</small>
            <strong>{armedClip.clipName}</strong>
            <span>
              {armedGroupName} · {armedLayer?.name || armedClip.layerName} · {t('visualControls.outputShort')}: {selectedOutputName}
            </span>
          </div>
          <div className="visual-take-dock-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => clearVisualCue()}
            >
              {t('visualControls.cancelPrepared')}
            </button>
            <button
              type="button"
              className="deck-take"
              disabled={busy !== null}
              onClick={() => void takeArmedClip()}
            >
              {busy?.startsWith('clip:') ? '…' : t('visualControls.take')} →
            </button>
          </div>
        </aside>
      )}
    </section>
  );
}
