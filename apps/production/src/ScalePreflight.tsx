import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  matchExternalSong,
  type SongIdentity,
  type SongMatchCandidate
} from '@millionsnest/nestlive-production-domain';
import type { SharedScale } from './musicScaleBridge';
import { buildServicePlan, type PreparedSongLink } from './servicePlanBuilder';
import { liveFeatureFlags } from './featureFlags';
import { syncPreparedServicePlan } from './liveCloudRepository';
import type { useLiveNode } from './useLiveNode';
import { ProductionPreflightChecklist } from './ProductionPreflightChecklist';
import { useEntitySyncState } from './useLiveSync';

type Controller = ReturnType<typeof useLiveNode>;

interface ExternalSong extends SongIdentity {
  key?: string;
  bpm?: number;
}

type RowStatus =
  | 'idle'
  | 'checking'
  | 'matched'
  | 'ambiguous'
  | 'missing'
  | 'creating'
  | 'error';

interface PreflightRow {
  source: SharedScale['songs'][number];
  status: RowStatus;
  matched?: SongMatchCandidate;
  candidates: SongMatchCandidate[];
  error?: string;
}

function lyricsFingerprint(value?: string): string | undefined {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) return undefined;

  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function matchHistoryKey(
  providerId: string,
  sourceId: string,
  externalId: string
): string {
  return `nestlive:match:${providerId}:${sourceId}:${externalId}`;
}

function matchHistoryWeight(
  providerId: string,
  sourceId: string,
  externalId: string
): number {
  try {
    const raw = window.localStorage.getItem(
      matchHistoryKey(providerId, sourceId, externalId)
    );
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { confirmations?: number };
    return Math.max(0, Math.min(10, Number(parsed.confirmations || 0) * 2));
  } catch {
    return 0;
  }
}

function rememberMatch(
  providerId: string,
  sourceId: string,
  externalId: string
): void {
  try {
    const key = matchHistoryKey(providerId, sourceId, externalId);
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) as { confirmations?: number } : {};
    window.localStorage.setItem(key, JSON.stringify({
      confirmations: Math.min(5, Number(parsed.confirmations || 0) + 1),
      lastConfirmedAt: new Date().toISOString()
    }));
  } catch {
    // History is a ranking hint only; preparation remains functional without it.
  }
}

function extractExternalSongs(
  results: Awaited<ReturnType<Controller['executeCommand']>>
): ExternalSong[] {
  return results
    .flatMap(result => {
      const value = result.observedState?.results;
      return Array.isArray(value) ? value : [];
    })
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      return {
        id: String(item.id || ''),
        title: String(item.title || ''),
        artist: item.artist ? String(item.artist) : undefined,
        version: item.version ? String(item.version) : undefined,
        lyricsFingerprint: lyricsFingerprint(
          typeof item.lyrics === 'string' ? item.lyrics : undefined
        ),
        key: item.key ? String(item.key) : undefined,
        bpm: typeof item.bpm === 'number' ? item.bpm : undefined
      };
    })
    .filter(item => item.id && item.title);
}

async function resolveSong(
  controller: Controller,
  providerId: string,
  source: SharedScale['songs'][number],
  actorId: string,
  scaleId: string
): Promise<PreflightRow> {
  try {
    const results = await controller.executeCommand({
      capability: 'songs.search',
      payload: {
        text: source.title,
        title: true,
        artist: true,
        fields: 'id,title,artist,version,lyrics,key,bpm'
      },
      liveSessionId: `preflight:${scaleId}`,
      actorId,
      targetProviderIds: [providerId]
    });

    const externalSongs = extractExternalSongs(results);
    const rankedSongs = externalSongs.map(song => ({
      ...song,
      historyWeight: matchHistoryWeight(providerId, source.id, song.id)
    }));
    const decision = matchExternalSong(
      {
        title: source.title,
        artist: source.artist,
        version: source.version,
        lyricsFingerprint: lyricsFingerprint(source.lyrics)
      },
      rankedSongs
    );

    if (decision.status === 'matched') {
      return {
        source,
        status: 'matched',
        matched: decision.candidate,
        candidates: [decision.candidate]
      };
    }

    if (decision.status === 'ambiguous') {
      return {
        source,
        status: 'ambiguous',
        candidates: decision.candidates
      };
    }

    return {
      source,
      status: 'missing',
      candidates: []
    };
  } catch (error) {
    return {
      source,
      status: 'error',
      candidates: [],
      error: error instanceof Error ? error.message : 'preflight_failed'
    };
  }
}

function toPreparedLinks(
  rows: PreflightRow[],
  providerId: string
): PreparedSongLink[] {
  return rows
    .filter((row): row is PreflightRow & { matched: SongMatchCandidate } =>
      row.status === 'matched' && Boolean(row.matched)
    )
    .map(row => ({
      musicScaleSongId: row.source.id,
      providerInstanceId: providerId,
      externalId: row.matched.id,
      fingerprint: `${row.matched.title}|${row.matched.artist || ''}`
    }));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export function ScalePreflight({
  controller,
  scale,
  actorId,
  onOpenLive
}: {
  controller: Controller;
  scale: SharedScale;
  actorId: string;
  onOpenLive?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PreflightRow[]>(
    scale.songs.map(source => ({ source, status: 'idle', candidates: [] }))
  );
  const rowsRef = useRef(rows);
  const [running, setRunning] = useState(false);
  const [creatingSongId, setCreatingSongId] = useState<string | null>(null);
  const [syncArmed, setSyncArmed] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [offlinePrepared, setOfflinePrepared] = useState(false);
  const [systemBlocked, setSystemBlocked] = useState(false);
  const [showReadyItems, setShowReadyItems] = useState(false);
  const servicePlanId = `music-scale:${scale.id}`;
  const cloudSync = useEntitySyncState('servicePlan', servicePlanId);
  const syncTimer = useRef<number | null>(null);
  const cachedSignature = useRef<string | null>(null);
  const autoCheckedSignature = useRef<string | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const scaleSignature = useMemo(
    () => `${scale.id}:${scale.publishRevision || 1}:${scale.songIds.join('|')}`,
    [scale.id, scale.publishRevision, scale.songIds]
  );

  useEffect(() => {
    setRows(current => {
      const byId = new Map(current.map(row => [row.source.id, row]));
      const next = scale.songs.map(source => {
        const existing = byId.get(source.id);
        return existing
          ? { ...existing, source }
          : { source, status: 'idle' as const, candidates: [] };
      });
      rowsRef.current = next;
      return next;
    });
    cachedSignature.current = null;
    autoCheckedSignature.current = null;
    setOfflinePrepared(false);
    setSyncArmed(false);
    setSyncMessage(null);
  }, [scaleSignature]);

  const capabilities = useMemo(
    () => new Set(
      (controller.nodeState?.providers || [])
        .filter(provider => provider.health === 'online' || provider.health === 'degraded')
        .flatMap(provider => provider.capabilities)
    ),
    [controller.nodeState]
  );

  const provider = useMemo(() => {
    const candidates = (controller.nodeState?.providers || []).filter(candidate =>
      (candidate.health === 'online' || candidate.health === 'degraded') &&
      candidate.capabilities.includes('songs.search')
    );
    const routedProviderId = controller.nodeState?.routing?.songs;
    if (routedProviderId) {
      return candidates.find(candidate => candidate.providerId === routedProviderId) || null;
    }
    return candidates.length === 1 ? candidates[0]! : null;
  }, [controller.nodeState]);

  const readyCount = rows.filter(row => row.status === 'matched' && row.matched).length;
  const unresolvedCount = rows.length - readyCount;
  const exceptionCount = rows.filter(row =>
    row.status !== 'matched' || !row.matched
  ).length;
  const visibleRows = showReadyItems
    ? rows
    : rows.filter(row => row.status !== 'matched' || !row.matched);
  const hasChecked = rows.some(row => row.status !== 'idle');
  const progress = rows.length > 0
    ? Math.round((readyCount / rows.length) * 100)
    : 0;
  const canSearch = Boolean(provider) && capabilities.has('songs.search');
  const canSync = Boolean(provider) && provider?.capabilities.includes('playlist.sync') === true;
  const canCreate = Boolean(provider) && provider?.capabilities.includes('songs.create') === true;
  const busy = running || Boolean(creatingSongId);

  async function persistPrepared(targetRows: PreflightRow[]) {
    if (!provider || !controller.credential) return;
    const prepared = toPreparedLinks(targetRows, provider.providerId);
    const { plan, providerLinks } = buildServicePlan(
      scale,
      {
        venueId: controller.credential.binding.venueId,
        liveSystemId: controller.credential.binding.liveSystemId
      },
      prepared
    );

    await controller.cacheServicePlan(plan, providerLinks);
    setOfflinePrepared(true);
    if (liveFeatureFlags.servicePlanWrites) {
      await syncPreparedServicePlan(plan, providerLinks, actorId).catch(() => {
        // The local Live Node already has the plan. The Sync Engine keeps
        // the truthful pending/offline/failed state for cloud recovery.
      });
    }
  }

  useEffect(() => {
    if (
      running ||
      creatingSongId ||
      !provider ||
      !controller.credential ||
      rows.length === 0 ||
      unresolvedCount > 0
    ) {
      if (unresolvedCount > 0) setOfflinePrepared(false);
      return;
    }

    const prepared = toPreparedLinks(rows, provider.providerId);
    const signature = prepared
      .map(link => `${link.musicScaleSongId}:${link.externalId}`)
      .join('|');

    if (!signature || cachedSignature.current === signature) return;
    cachedSignature.current = signature;

    void persistPrepared(rows).catch(() => {
      cachedSignature.current = null;
      setOfflinePrepared(false);
    });
  }, [
    controller.credential,
    creatingSongId,
    provider,
    rows,
    running,
    scaleSignature,
    unresolvedCount
  ]);

  async function runPreflight() {
    if (!provider || !canSearch || busy) return;
    setRunning(true);
    setSyncMessage(null);

    const nextRows: PreflightRow[] = [];
    for (const source of scale.songs) {
      setRows(current => current.map(row =>
        row.source.id === source.id
          ? { ...row, status: 'checking', error: undefined }
          : row
      ));

      const resolved = await resolveSong(
        controller,
        provider.providerId,
        source,
        actorId,
        scale.id
      );
      nextRows.push(resolved);
      setRows(current => current.map(row =>
        row.source.id === resolved.source.id ? resolved : row
      ));
    }

    rowsRef.current = nextRows;
    setRows(nextRows);
    setRunning(false);
  }

  useEffect(() => {
    if (!provider || !canSearch || busy || !rows.length) return;
    if (rows.some(row => row.status !== 'idle')) return;

    const signature = `${scaleSignature}:${provider.providerId}`;
    if (autoCheckedSignature.current === signature) return;

    const timer = window.setTimeout(() => {
      if (autoCheckedSignature.current === signature) return;
      autoCheckedSignature.current = signature;
      void runPreflight();
    }, 420);

    return () => window.clearTimeout(timer);
  }, [
    busy,
    canSearch,
    provider,
    rows,
    scaleSignature
  ]);

  function chooseCandidate(sourceId: string, externalId: string) {
    setRows(current => {
      const next = current.map(row => {
        if (row.source.id !== sourceId) return row;
        const matched = row.candidates.find(candidate => candidate.id === externalId);
        if (matched) {
          if (provider) rememberMatch(provider.providerId, sourceId, matched.id);
          return { ...row, status: 'matched' as const, matched };
        }
        return { ...row, status: 'ambiguous' as const, matched: undefined };
      });
      rowsRef.current = next;
      return next;
    });
  }

  async function performPlaylistSync(
    targetRows: PreflightRow[],
    successMessage = t('preflight.syncDoneOffline')
  ) {
    if (!provider || !canSync) return false;
    const ids = targetRows
      .map(row => row.matched?.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length !== targetRows.length || ids.length === 0) return false;

    const result = await controller.executeCommand({
      capability: 'playlist.sync',
      payload: { ids },
      liveSessionId: `music-scale:${scale.id}`,
      actorId,
      targetProviderIds: [provider.providerId],
      safetyLevel: 'guarded',
      confirmed: true
    });
    const failed = result.find(item => !item.accepted);

    if (failed) {
      setSyncMessage(t('preflight.syncFailed', {
        code: failed.errorCode || 'provider_error'
      }));
      return false;
    }

    await persistPrepared(targetRows);
    setSyncMessage(successMessage);
    return true;
  }

  async function syncPlaylist() {
    if (!canSync || unresolvedCount > 0 || busy) return;

    if (!syncArmed) {
      setSyncArmed(true);
      setSyncMessage(t('preflight.replaceWarning'));
      if (syncTimer.current) window.clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(() => {
        setSyncArmed(false);
        setSyncMessage(null);
      }, 5000);
      return;
    }

    setSyncArmed(false);
    setRunning(true);
    setSyncMessage(null);
    try {
      await performPlaylistSync(rows);
    } catch (error) {
      setSyncMessage(t('preflight.syncFailed', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    } finally {
      setRunning(false);
    }
  }

  async function createMissingSong(source: SharedScale['songs'][number]) {
    if (!provider || !canCreate || busy) return;
    const lyrics = String(source.lyrics || '').trim();
    if (!lyrics) {
      setSyncMessage(t('preflight.createNeedsLyrics', { title: source.title }));
      return;
    }

    setCreatingSongId(source.id);
    setSyncMessage(null);
    setRows(current => {
      const next = current.map(row =>
        row.source.id === source.id
          ? { ...row, status: 'creating' as const, error: undefined }
          : row
      );
      rowsRef.current = next;
      return next;
    });

    try {
      const creation = await controller.executeCommand({
        capability: 'songs.create',
        payload: {
          title: source.title,
          artist: source.artist || undefined,
          lyrics,
          key: source.selectedKey || source.key || undefined,
          bpm: source.selectedBpm ?? source.bpm ?? undefined,
          note: 'NestLive'
        },
        liveSessionId: `preflight:${scale.id}`,
        actorId,
        targetProviderIds: [provider.providerId],
        safetyLevel: 'guarded',
        confirmed: true
      });

      const failed = creation.find(result => !result.accepted);
      if (failed) {
        throw new Error(failed.errorCode || 'song_create_failed');
      }

      const providerNeedsSave = creation.some(result =>
        result.observedState?.requiresProviderSave === true
      );
      setSyncMessage(providerNeedsSave
        ? t('preflight.createOpened', { title: source.title })
        : t('preflight.createRequested', { title: source.title })
      );

      let matchedRow: PreflightRow | null = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await wait(1500);
        const resolved = await resolveSong(
          controller,
          provider.providerId,
          source,
          actorId,
          scale.id
        );
        if (resolved.status === 'matched' && resolved.matched) {
          matchedRow = resolved;
          break;
        }
      }

      if (!matchedRow) {
        setRows(current => {
          const next = current.map(row =>
            row.source.id === source.id
              ? { ...row, status: 'missing' as const }
              : row
          );
          rowsRef.current = next;
          return next;
        });
        setSyncMessage(t('preflight.createWaiting', { title: source.title }));
        return;
      }

      const nextRows = rowsRef.current.map(row =>
        row.source.id === source.id ? matchedRow! : row
      );
      rowsRef.current = nextRows;
      setRows(nextRows);
      setSyncMessage(t('preflight.createDetected', { title: source.title }));

      if (
        canSync &&
        nextRows.length > 0 &&
        nextRows.every(row => row.status === 'matched' && row.matched)
      ) {
        await performPlaylistSync(
          nextRows,
          t('preflight.createAndSyncDone', { title: source.title })
        );
      }
    } catch (error) {
      setRows(current => {
        const next = current.map(row =>
          row.source.id === source.id
            ? {
                ...row,
                status: 'error' as const,
                error: error instanceof Error ? error.message : 'song_create_failed'
              }
            : row
        );
        rowsRef.current = next;
        return next;
      });
      setSyncMessage(t('preflight.createFailed', {
        title: source.title,
        code: error instanceof Error ? error.message : 'song_create_failed'
      }));
    } finally {
      setCreatingSongId(null);
    }
  }

  const readinessState =
    running
      ? 'checking'
      : rows.length > 0 && unresolvedCount === 0 && offlinePrepared && !systemBlocked
        ? 'ready'
        : rows.length > 0 && unresolvedCount === 0 && systemBlocked
          ? 'attention'
          : rows.length > 0 && unresolvedCount === 0
            ? 'caching'
          : hasChecked
            ? 'attention'
            : 'idle';

  return (
    <section className="preflight-panel">
      <div className="preflight-header">
        <div>
          <span className="eyebrow">{t('preflight.kicker')}</span>
          <h2>{t('preflight.title')}</h2>
          <p>{scale.eventName || t('nextService')} · {scale.date}{scale.time ? ` · ${scale.time}` : ''}</p>
        </div>
        <div className="preflight-score">
          <strong>{readyCount}/{rows.length}</strong>
          <small>{t('preflight.ready')}</small>
          {offlinePrepared && <em>{t('preflight.offlineReady')}</em>}
          {liveFeatureFlags.servicePlanWrites && offlinePrepared && (
            <em className={`cloud-sync-${cloudSync?.status || 'local'}`}>
              {t(`syncState.${cloudSync?.status || 'local'}`)}
            </em>
          )}
        </div>
      </div>

      <div className={`preflight-guidance state-${readinessState}`}>
        <div className="preflight-guidance-copy">
          <span className="preflight-guidance-dot" aria-hidden="true" />
          <div>
            <strong>{t(`preflight.guidance.${readinessState}.title`, {
              count: unresolvedCount,
              provider: provider?.displayName || provider?.providerKey || ''
            })}</strong>
            <small>{t(`preflight.guidance.${readinessState}.hint`, {
              count: unresolvedCount,
              provider: provider?.displayName || provider?.providerKey || ''
            })}</small>
          </div>
        </div>
        <div className="preflight-progress" aria-label={t('preflight.progressLabel', { progress })}>
          <div><span style={{ width: `${progress}%` }} /></div>
          <strong>{progress}%</strong>
        </div>
      </div>

      <ProductionPreflightChecklist
        controller={controller}
        actorId={actorId}
        liveSessionId={`preflight:${scale.id}`}
        scaleHasSongs={scale.songs.length > 0}
        onBlockingChange={setSystemBlocked}
      />

      <div className="preflight-actions">
        <button
          className="secondary"
          disabled={!canSearch || busy || !rows.length}
          onClick={() => void runPreflight()}
        >
          {running
            ? t('preflight.checking')
            : hasChecked
              ? t('preflight.recheck')
              : t('preflight.check')}
        </button>
        <button
          className={syncArmed ? 'primary danger-confirm' : 'primary'}
          disabled={!canSync || unresolvedCount > 0 || busy || !rows.length}
          onClick={() => void syncPlaylist()}
        >
          {syncArmed ? t('preflight.confirmReplace') : t('preflight.sync')}
        </button>
        {offlinePrepared && unresolvedCount === 0 && onOpenLive && (
          <button
            type="button"
            className="primary preflight-open-live"
            disabled={busy || systemBlocked}
            title={systemBlocked ? t('productionPreflight.resolveBeforeLive') : undefined}
            onClick={onOpenLive}
          >
            {t('preflight.openLive')}
          </button>
        )}
      </div>

      <div className="preflight-exception-bar">
        <div>
          <strong>
            {exceptionCount > 0
              ? t('preflight.exceptionsRemaining', { count: exceptionCount })
              : t('preflight.noExceptions')}
          </strong>
          <small>
            {showReadyItems
              ? t('preflight.showingAll', { count: rows.length })
              : t('preflight.readyCollapsed', { count: readyCount })}
          </small>
        </div>
        {readyCount > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setShowReadyItems(value => !value)}
          >
            {showReadyItems
              ? t('preflight.hideReady')
              : t('preflight.showReady', { count: readyCount })}
          </button>
        )}
      </div>

      <div className="preflight-list">
        {visibleRows.map(row => {
          const index = rows.findIndex(candidate => candidate.source.id === row.source.id);
          return (
          <div className="preflight-row" key={row.source.id}>
            <b>{String(index + 1).padStart(2, '0')}</b>
            <div className="preflight-song">
              <strong>{row.source.title}</strong>
              <small>{row.source.artist || ''}</small>
            </div>
            <div className={`preflight-state state-${row.status}`}>
              {row.status === 'idle' && t('preflight.idle')}
              {row.status === 'checking' && t('preflight.checking')}
              {row.status === 'creating' && t('preflight.creating')}
              {row.status === 'matched' && row.matched && (
                <span title={[
                  row.matched.id,
                  typeof row.matched.score === 'number'
                    ? `${row.matched.score}%`
                    : '',
                  Array.isArray(row.matched.reasons)
                    ? row.matched.reasons.join(', ')
                    : ''
                ].filter(Boolean).join(' · ')}>
                  {t('preflight.matched')} · {row.matched.title}
                  {typeof row.matched.score === 'number'
                    ? ` · ${row.matched.score}%`
                    : ''}
                </span>
              )}
              {row.status === 'missing' && (
                <div className="preflight-missing-actions">
                  <span>{t('preflight.missing')}</span>
                  {canCreate && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !row.source.lyrics?.trim()}
                      title={!row.source.lyrics?.trim()
                        ? t('preflight.createNeedsLyrics', { title: row.source.title })
                        : undefined}
                      onClick={() => void createMissingSong(row.source)}
                    >
                      {t('preflight.createSong')}
                    </button>
                  )}
                </div>
              )}
              {row.status === 'error' && (
                <span title={row.error}>{t('preflight.error')}</span>
              )}
              {row.status === 'ambiguous' && (
                <select
                  value=""
                  onChange={event => chooseCandidate(row.source.id, event.target.value)}
                  aria-label={t('preflight.choose')}
                >
                  <option value="">{t('preflight.choose')}</option>
                  {row.candidates.map(candidate => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.title}{candidate.artist ? ` — ${candidate.artist}` : ''}{typeof candidate.score === 'number' ? ` · ${candidate.score}%` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        );
        })}
      </div>

      {!canSearch && <p className="preflight-note">{t('preflight.searchUnavailable')}</p>}
      {canSearch && !canSync && <p className="preflight-note">{t('preflight.syncUnavailable')}</p>}
      {canSearch && !canCreate && (
        <p className="preflight-note">{t('preflight.createUnavailable')}</p>
      )}
      {syncMessage && <p className="preflight-message">{syncMessage}</p>}
    </section>
  );
}
