import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveDropAsset } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import type {
  LiveDropRetentionPolicy,
  LiveDropRetentionPreset
} from './liveNodeClient';

type Controller = ReturnType<typeof useLiveNode>;

const ACCEPT = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.flac',
  '.pdf'
].join(',');

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function canOpenMedia(asset: LiveDropAsset): boolean {
  return ['image', 'video', 'audio'].includes(asset.mediaType);
}

function retentionHours(value: number | null | undefined): number | null {
  if (!value || value <= 0) return null;
  return Math.max(1, Math.round(value / (60 * 60 * 1000)));
}

function retentionPreset(
  retention: LiveDropRetentionPolicy | null
): LiveDropRetentionPreset | 'custom' | null {
  if (!retention) return null;
  const day = 24 * 60 * 60 * 1000;
  if (
    retention.quarantineTtlMs === day &&
    retention.rejectedTtlMs === 60 * 60 * 1000
  ) {
    if (retention.readyTtlMs === day) return 'service';
    if (retention.readyTtlMs === 7 * day) return 'week';
    if (retention.readyTtlMs === null) return 'keep';
  }
  return 'custom';
}

export function LiveDropPanel({
  controller,
  actorId,
  liveSessionId
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [assets, setAssets] = useState<LiveDropAsset[]>(controller.nodeState?.liveDrop || []);
  const [maxBytes, setMaxBytes] = useState(250 * 1024 * 1024);
  const [retention, setRetention] = useState<LiveDropRetentionPolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState<LiveDropRetentionPreset | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAssetId, setBusyAssetId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAssets(controller.nodeState?.liveDrop || []);
  }, [controller.nodeState?.liveDrop]);

  useEffect(() => {
    let cancelled = false;
    void controller.listLiveDrop()
      .then(result => {
        if (cancelled) return;
        setAssets(result.assets);
        setMaxBytes(result.maxBytes);
        setRetention(result.retention || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [controller.listLiveDrop]);

  const mediaRoute = useMemo(() => {
    const providers = (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('media.open')
    );
    const configured = controller.nodeState?.routing?.media;
    const selected = configured
      ? providers.find(provider => provider.providerId === configured)
      : providers.length === 1
        ? providers[0]
        : null;

    return {
      providers,
      selected: selected || null,
      ambiguous: providers.length > 1 && !selected
    };
  }, [controller.nodeState]);

  async function uploadFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (!incoming.length || uploading) return;

    setUploading(true);
    setMessage(null);
    let uploaded = 0;

    try {
      for (const file of incoming) {
        if (file.size > maxBytes) {
          setMessage(t('liveDrop.fileTooLarge', {
            name: file.name,
            max: formatBytes(maxBytes)
          }));
          continue;
        }

        try {
          await controller.uploadLiveDrop(file, actorId);
          uploaded += 1;
        } catch (error) {
          setMessage(t('liveDrop.uploadFailed', {
            name: file.name,
            code: error instanceof Error ? error.message : 'live_drop_upload_failed'
          }));
        }
      }

      const refreshed = await controller.listLiveDrop();
      setAssets(refreshed.assets);
      setMaxBytes(refreshed.maxBytes);
      setRetention(refreshed.retention || null);
      if (uploaded > 0) {
        setMessage(t('liveDrop.uploaded', { count: uploaded }));
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function review(asset: LiveDropAsset, status: 'ready' | 'rejected') {
    setBusyAssetId(asset.id);
    setMessage(null);
    try {
      await controller.reviewLiveDrop(asset.id, status, actorId);
      const refreshed = await controller.listLiveDrop();
      setAssets(refreshed.assets);
      setRetention(refreshed.retention || null);
      setMessage(status === 'ready'
        ? t('liveDrop.approved', { name: asset.fileName })
        : t('liveDrop.rejected', { name: asset.fileName })
      );
    } catch (error) {
      setMessage(t('liveDrop.reviewFailed', {
        code: error instanceof Error ? error.message : 'live_drop_review_failed'
      }));
    } finally {
      setBusyAssetId(null);
    }
  }

  async function changeRetentionPreset(preset: LiveDropRetentionPreset) {
    if (policyBusy) return;
    setPolicyBusy(preset);
    setMessage(null);
    try {
      const next = await controller.setLiveDropRetentionPreset(preset);
      setRetention(next);
      const refreshed = await controller.listLiveDrop();
      setAssets(refreshed.assets);
      setMaxBytes(refreshed.maxBytes);
      setRetention(refreshed.retention || next);
      setMessage(t(`liveDrop.policy.saved.${preset}`));
    } catch (error) {
      setMessage(t('liveDrop.policy.saveFailed', {
        code: error instanceof Error ? error.message : 'live_drop_policy_failed'
      }));
    } finally {
      setPolicyBusy(null);
    }
  }

  async function openAsset(asset: LiveDropAsset) {
    if (!canOpenMedia(asset) || !mediaRoute.selected) return;
    setBusyAssetId(asset.id);

    const providerName =
      mediaRoute.selected.displayName ||
      mediaRoute.selected.providerKey ||
      'provider';
    const remote =
      Boolean(mediaRoute.selected.nodeId) &&
      mediaRoute.selected.nodeId !== controller.nodeState?.nodeId;

    setMessage(remote
      ? t('liveDrop.transferring', {
          name: asset.fileName,
          provider: providerName
        })
      : null
    );

    try {
      const response = await controller.openLiveDrop(asset.id, {
        actorId,
        liveSessionId,
        providerId: mediaRoute.selected.providerId
      });
      const failed = response.results.find(result => !result.accepted);
      if (failed) {
        setMessage(t('liveDrop.openFailed', {
          code: failed.errorCode || 'provider_error'
        }));
      } else if (response.transfer?.mode === 'replicated') {
        setMessage(t('liveDrop.replicatedAndOpened', {
          name: asset.fileName,
          provider: providerName
        }));
      } else if (response.transfer?.mode === 'reused') {
        setMessage(t('liveDrop.reusedAndOpened', {
          name: asset.fileName,
          provider: providerName
        }));
      } else {
        setMessage(t('liveDrop.opened', {
          name: asset.fileName,
          provider: providerName
        }));
      }
    } catch (error) {
      setMessage(t('liveDrop.openFailed', {
        code: error instanceof Error ? error.message : 'live_drop_open_failed'
      }));
    } finally {
      setBusyAssetId(null);
    }
  }

  const quarantined = assets.filter(asset => asset.status === 'quarantined');
  const ready = assets.filter(asset => asset.status === 'ready');
  const rejected = assets.filter(asset => asset.status === 'rejected');

  return (
    <section className="live-drop-panel">
      <div className="live-drop-head">
        <div>
          <span className="eyebrow">{t('liveDrop.kicker')}</span>
          <h2>{t('liveDrop.title')}</h2>
          <p>{t('liveDrop.description')}</p>
        </div>
        <div className="live-drop-security">
          <strong>{t('liveDrop.quarantineTitle')}</strong>
          <small>{t('liveDrop.quarantineHint')}</small>
        </div>
      </div>

      <div className="live-drop-policy" aria-label={t('liveDrop.policy.label')}>
        <div className="live-drop-policy-copy">
          <span>{t('liveDrop.policy.kicker')}</span>
          <strong>{t('liveDrop.policy.title')}</strong>
          <small>{t('liveDrop.policy.description')}</small>
          <div className="live-drop-policy-presets" role="group" aria-label={t('liveDrop.policy.presetsLabel')}>
            {(['service','week','keep'] as LiveDropRetentionPreset[]).map(preset => (
              <button
                key={preset}
                type="button"
                className={retentionPreset(retention) === preset ? 'active' : ''}
                disabled={policyBusy !== null}
                onClick={() => void changeRetentionPreset(preset)}
              >
                <strong>{t(`liveDrop.policy.presets.${preset}.title`)}</strong>
                <small>{t(`liveDrop.policy.presets.${preset}.hint`)}</small>
                {policyBusy === preset && <em>…</em>}
              </button>
            ))}
          </div>
        </div>
        <div className="live-drop-policy-states">
          <article>
            <span className="policy-dot quarantine" />
            <div>
              <small>{t('liveDrop.policy.quarantine')}</small>
              <strong>
                {retention
                  ? t('liveDrop.policy.hours', {
                      count: retentionHours(retention.quarantineTtlMs) || 24
                    })
                  : t('liveDrop.policy.nodeDefault')}
              </strong>
              <em>{t('liveDrop.policy.quarantineHint')}</em>
            </div>
          </article>
          <article>
            <span className="policy-dot ready" />
            <div>
              <small>{t('liveDrop.policy.approved')}</small>
              <strong>
                {retention
                  ? retention.readyTtlMs
                    ? t('liveDrop.policy.hours', {
                        count: retentionHours(retention.readyTtlMs) || 1
                      })
                    : t('liveDrop.policy.kept')
                  : t('liveDrop.policy.nodeDefault')}
              </strong>
              <em>{t('liveDrop.policy.approvedHint')}</em>
            </div>
          </article>
          <article>
            <span className="policy-dot rejected" />
            <div>
              <small>{t('liveDrop.policy.rejected')}</small>
              <strong>
                {retention
                  ? t('liveDrop.policy.hours', {
                      count: retentionHours(retention.rejectedTtlMs) || 1
                    })
                  : t('liveDrop.policy.nodeDefault')}
              </strong>
              <em>{t('liveDrop.policy.rejectedHint')}</em>
            </div>
          </article>
        </div>
      </div>

      <button
        type="button"
        className={`live-drop-zone ${dragging ? 'dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={event => {
          event.preventDefault();
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={event => {
          event.preventDefault();
          setDragging(false);
          void uploadFiles(event.dataTransfer.files);
        }}
        disabled={uploading}
      >
        <span className="live-drop-plus" aria-hidden="true">+</span>
        <strong>{uploading ? t('liveDrop.uploading') : t('liveDrop.dropTitle')}</strong>
        <small>{t('liveDrop.dropHint', { max: formatBytes(maxBytes) })}</small>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={event => {
            if (event.target.files) void uploadFiles(event.target.files);
          }}
        />
      </button>

      {message && <p className="live-drop-message" role="status">{message}</p>}

      {quarantined.length > 0 && (
        <div className="live-drop-group">
          <div className="live-drop-group-head">
            <div>
              <strong>{t('liveDrop.pendingTitle')}</strong>
              <small>{t('liveDrop.pendingHint')}</small>
            </div>
            <span>{quarantined.length}</span>
          </div>
          <div className="live-drop-list">
            {quarantined.map(asset => (
              <article key={asset.id} className="live-drop-card pending">
                <div className="live-drop-file">
                  <span>{asset.mediaType.toUpperCase()}</span>
                  <div>
                    <strong>{asset.fileName}</strong>
                    <small>
                      {formatBytes(asset.sizeBytes)} · SHA-256 {asset.sha256.slice(0, 10)}
                    </small>
                  </div>
                </div>
                <div className="live-drop-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busyAssetId === asset.id}
                    onClick={() => void review(asset, 'rejected')}
                  >
                    {t('liveDrop.reject')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busyAssetId === asset.id}
                    onClick={() => void review(asset, 'ready')}
                  >
                    {busyAssetId === asset.id ? '…' : t('liveDrop.approve')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {ready.length > 0 && (
        <div className="live-drop-group">
          <div className="live-drop-group-head">
            <div>
              <strong>{t('liveDrop.readyTitle')}</strong>
              <small>{t('liveDrop.readyHint')}</small>
            </div>
            <span>{ready.length}</span>
          </div>
          <div className="live-drop-list">
            {ready.map(asset => {
              const openable = canOpenMedia(asset);
              return (
                <article key={asset.id} className="live-drop-card ready">
                  <div className="live-drop-file">
                    <span>{asset.mediaType.toUpperCase()}</span>
                    <div>
                      <strong>{asset.fileName}</strong>
                      <small>{formatBytes(asset.sizeBytes)} · {t('liveDrop.cachedLocal')}</small>
                    </div>
                  </div>
                  <div className="live-drop-actions">
                    {openable && (
                      <button
                        type="button"
                        className="primary"
                        disabled={
                          busyAssetId === asset.id ||
                          !mediaRoute.selected ||
                          mediaRoute.ambiguous
                        }
                        title={mediaRoute.ambiguous
                          ? t('liveDrop.routeRequired')
                          : !mediaRoute.selected
                            ? t('liveDrop.providerUnavailable')
                            : undefined}
                        onClick={() => void openAsset(asset)}
                      >
                        {busyAssetId === asset.id ? '…' : t('liveDrop.open')}
                      </button>
                    )}
                    {!openable && (
                      <span className="live-drop-cached-badge">{t('liveDrop.cached')}</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {!quarantined.length && !ready.length && (
        <div className="live-drop-empty">
          <strong>{t('liveDrop.emptyTitle')}</strong>
          <span>{t('liveDrop.emptyHint')}</span>
        </div>
      )}

      {mediaRoute.ambiguous && ready.some(canOpenMedia) && (
        <p className="live-drop-note">{t('liveDrop.routeRequired')}</p>
      )}
      {!mediaRoute.providers.length && ready.some(canOpenMedia) && (
        <p className="live-drop-note">{t('liveDrop.providerUnavailable')}</p>
      )}
      {rejected.length > 0 && (
        <p className="live-drop-audit">
          {t('liveDrop.rejectedAudit', { count: rejected.length })}
        </p>
      )}
    </section>
  );
}
