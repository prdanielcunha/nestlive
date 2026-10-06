import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CommandResult,
  LiveDropAsset,
  ServiceItem
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { createClientId } from './clientId';

type Controller = ReturnType<typeof useLiveNode>;
type LibraryKind = 'video' | 'image' | 'audio';

interface ProviderLibraryItem {
  id: string;
  source: 'provider';
  providerId: string;
  providerName: string;
  kind: LibraryKind;
  name: string;
  isDir: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
}

interface LiveDropLibraryItem {
  id: string;
  source: 'live-drop';
  asset: LiveDropAsset;
  kind: LibraryKind;
  name: string;
}

type LibraryItem = ProviderLibraryItem | LiveDropLibraryItem;

function mediaThumbnailUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (normalized.startsWith('data:image/')) return normalized;
  const mime = normalized.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${normalized}`;
}

function normalizeProviderResults(
  results: CommandResult[],
  providerId: string,
  providerName: string,
  kind: LibraryKind
): ProviderLibraryItem[] {
  return results
    .filter(result => result.providerInstanceId === providerId)
    .flatMap(result => {
      const value = result.observedState?.results;
      return Array.isArray(value) ? value : [];
    })
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      const name = String(item.name || item.file || '').trim();
      return {
        id: `provider:${providerId}:${kind}:${name}`,
        source: 'provider' as const,
        providerId,
        providerName,
        kind,
        name,
        isDir: Boolean(item.isDir),
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : undefined,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined,
        thumbnail: typeof item.thumbnail === 'string'
          ? mediaThumbnailUrl(item.thumbnail)
          : undefined
      };
    })
    .filter(item => item.name);
}

function liveDropKind(asset: LiveDropAsset): LibraryKind | null {
  if (asset.mediaType === 'video') return 'video';
  if (asset.mediaType === 'image') return 'image';
  if (asset.mediaType === 'audio') return 'audio';
  return null;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function UniversalMediaLibrary({
  controller,
  actorId,
  liveSessionId
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LibraryKind>('video');
  const [query, setQuery] = useState('');
  const [providerItems, setProviderItems] = useState<ProviderLibraryItem[]>([]);
  const [liveDropAssets, setLiveDropAssets] = useState<LiveDropAsset[]>(
    controller.nodeState?.liveDrop || []
  );
  const [searching, setSearching] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [armedItemId, setArmedItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const confirmationTimer = useRef<number | null>(null);

  const servicePlan = controller.nodeState?.state.servicePlan || null;
  const providerLinks = controller.nodeState?.state.providerLinks || [];
  const activeServiceItemId = controller.nodeState?.state.activeServiceItemId || null;

  useEffect(() => {
    setLiveDropAssets(controller.nodeState?.liveDrop || []);
  }, [controller.nodeState?.liveDrop]);

  useEffect(() => {
    let cancelled = false;
    void controller.listLiveDrop()
      .then(result => {
        if (!cancelled) setLiveDropAssets(result.assets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [controller.listLiveDrop]);

  useEffect(() => {
    setProviderItems([]);
    setArmedItemId(null);
    setMessage(null);
  }, [kind]);

  const searchProviders = useMemo(
    () => (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('media.search')
    ),
    [controller.nodeState]
  );

  const openProviders = useMemo(
    () => (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('media.open')
    ),
    [controller.nodeState]
  );

  const routedMediaProvider = useMemo(() => {
    const configured = controller.nodeState?.routing?.media;
    if (configured) {
      return openProviders.find(provider => provider.providerId === configured) || null;
    }
    return openProviders.length === 1 ? openProviders[0]! : null;
  }, [controller.nodeState?.routing?.media, openProviders]);

  const localItems = useMemo<LiveDropLibraryItem[]>(
    () => liveDropAssets
      .filter(asset => asset.status === 'ready')
      .map(asset => {
        const assetKind = liveDropKind(asset);
        if (!assetKind) return null;
        return {
          id: `live-drop:${asset.id}`,
          source: 'live-drop' as const,
          asset,
          kind: assetKind,
          name: asset.fileName
        };
      })
      .filter((item): item is LiveDropLibraryItem => Boolean(item))
      .filter(item => item.kind === kind)
      .filter(item =>
        !query.trim() ||
        item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      ),
    [kind, liveDropAssets, query]
  );

  const items = useMemo<LibraryItem[]>(
    () => [...localItems, ...providerItems]
      .filter(item => !('isDir' in item) || !item.isDir)
      .sort((left, right) => {
        if (left.source !== right.source) return left.source === 'live-drop' ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [localItems, providerItems]
  );

  async function search() {
    if (!searchProviders.length || searching) return;
    setSearching(true);
    setMessage(null);
    try {
      const batches = await Promise.all(
        searchProviders.map(async provider => {
          const results = await controller.executeCommand({
            capability: 'media.search',
            payload: {
              kind,
              filter: query.trim(),
              includeMetadata: true,
              includeThumbnail: kind !== 'audio'
            },
            liveSessionId,
            actorId,
            targetProviderIds: [provider.providerId],
            safetyLevel: 'normal'
          });
          return normalizeProviderResults(
            results,
            provider.providerId,
            provider.displayName || provider.providerKey || t('universalLibrary.providerFallback'),
            kind
          );
        })
      );
      setProviderItems(batches.flat());
      setMessage(t('universalLibrary.searchDone', {
        count: batches.flat().length,
        providers: searchProviders.length
      }));
    } catch (error) {
      setMessage(t('universalLibrary.searchFailed', {
        code: error instanceof Error ? error.message : 'media_library_search_failed'
      }));
    } finally {
      setSearching(false);
    }
  }

  function arm(item: LibraryItem) {
    if (armedItemId === item.id) {
      void open(item);
      return;
    }
    setArmedItemId(item.id);
    setMessage(t('universalLibrary.confirmOpen', { name: item.name }));
    if (confirmationTimer.current) window.clearTimeout(confirmationTimer.current);
    confirmationTimer.current = window.setTimeout(() => {
      setArmedItemId(null);
      setMessage(null);
    }, 5000);
  }

  async function open(item: LibraryItem) {
    setArmedItemId(null);
    setBusyItemId(item.id);
    setMessage(null);
    try {
      if (item.source === 'live-drop') {
        if (!routedMediaProvider) {
          setMessage(
            openProviders.length > 1
              ? t('universalLibrary.routeRequired')
              : t('universalLibrary.openUnavailable')
          );
          return;
        }
        const result = await controller.openLiveDrop(item.asset.id, {
          actorId,
          liveSessionId,
          providerId: routedMediaProvider.providerId
        });
        const failed = result.results.find(candidate => !candidate.accepted);
        if (failed) {
          throw new Error(failed.errorCode || 'media_open_failed');
        }
        setMessage(t('universalLibrary.opened', {
          name: item.name,
          provider: routedMediaProvider.displayName ||
            routedMediaProvider.providerKey ||
            t('universalLibrary.providerFallback')
        }));
        return;
      }

      const results = await controller.executeCommand({
        capability: 'media.open',
        payload: {
          kind: item.kind,
          file: item.name
        },
        liveSessionId,
        actorId,
        targetProviderIds: [item.providerId],
        safetyLevel: 'guarded',
        confirmed: true
      });
      const failed = results.find(candidate => !candidate.accepted);
      if (failed) throw new Error(failed.errorCode || 'media_open_failed');
      setMessage(t('universalLibrary.opened', {
        name: item.name,
        provider: item.providerName
      }));
    } catch (error) {
      setMessage(t('universalLibrary.openFailed', {
        code: error instanceof Error ? error.message : 'media_open_failed'
      }));
    } finally {
      setBusyItemId(null);
    }
  }

  async function addToService(item: LibraryItem, placement: 'next' | 'end') {
    if (!servicePlan || busyItemId) return;
    setBusyItemId(item.id);
    setMessage(null);

    try {
      const payload: Record<string, unknown> = item.source === 'provider'
        ? {
            source: 'provider',
            kind: item.kind,
            file: item.name,
            providerId: item.providerId,
            providerName: item.providerName,
            durationMs: item.durationMs,
            width: item.width,
            height: item.height
          }
        : {
            source: 'live-drop',
            kind: item.kind,
            assetId: item.asset.id,
            fileName: item.asset.fileName,
            sha256: item.asset.sha256,
            providerId: routedMediaProvider?.providerId
          };

      const runtimeItem: ServiceItem = {
        id: `live-media:${createClientId()}`,
        type: item.kind,
        title: item.name,
        state: 'planned',
        payload
      };

      const items = [...servicePlan.items];
      const activeIndex = activeServiceItemId
        ? items.findIndex(candidate => candidate.id === activeServiceItemId)
        : items.findIndex(candidate => candidate.state === 'live');
      const insertIndex = placement === 'next'
        ? Math.max(0, activeIndex >= 0 ? activeIndex + 1 : 0)
        : items.length;
      items.splice(insertIndex, 0, runtimeItem);

      await controller.cacheServicePlan({
        ...servicePlan,
        items,
        revision: servicePlan.revision + 1,
        metadata: {
          ...(servicePlan.metadata || {}),
          lastLiveEditAt: new Date().toISOString()
        }
      }, providerLinks);

      setMessage(t(
        placement === 'next'
          ? 'universalLibrary.addedNext'
          : 'universalLibrary.addedEnd',
        { name: item.name }
      ));
    } catch (error) {
      setMessage(t('universalLibrary.addFailed', {
        code: error instanceof Error ? error.message : 'service_plan_update_failed'
      }));
    } finally {
      setBusyItemId(null);
    }
  }

  function metadata(item: LibraryItem): string {
    if (item.source === 'live-drop') {
      return `${formatBytes(item.asset.sizeBytes)} · ${t('universalLibrary.localCache')}`;
    }
    if (item.width && item.height) return `${item.width}×${item.height}`;
    if (item.durationMs) return `${Math.round(item.durationMs / 1000)}s`;
    return t(`universalLibrary.kinds.${item.kind}`);
  }

  return (
    <section className="universal-library">
      <div className="universal-library-head">
        <div>
          <span className="eyebrow">{t('universalLibrary.kicker')}</span>
          <h2>{t('universalLibrary.title')}</h2>
          <p>{t('universalLibrary.description')}</p>
        </div>
        <div className="universal-library-sources">
          <strong>{localItems.length + providerItems.length}</strong>
          <span>{t('universalLibrary.visibleItems')}</span>
          <small>
            {t('universalLibrary.sourceSummary', {
              drops: localItems.length,
              providers: searchProviders.length
            })}
          </small>
        </div>
      </div>

      <div className="universal-library-toolbar">
        <div className="universal-library-kinds" role="group" aria-label={t('universalLibrary.kindLabel')}>
          {(['video', 'image', 'audio'] as LibraryKind[]).map(value => (
            <button
              type="button"
              key={value}
              className={kind === value ? 'active' : ''}
              onClick={() => setKind(value)}
            >
              {t(`universalLibrary.kinds.${value}`)}
            </button>
          ))}
        </div>
        <div className="universal-library-search">
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void search();
            }}
            placeholder={t('universalLibrary.searchPlaceholder')}
          />
          <button
            type="button"
            className="primary"
            disabled={searching || !searchProviders.length}
            onClick={() => void search()}
          >
            {searching ? t('universalLibrary.searching') : t('universalLibrary.search')}
          </button>
        </div>
      </div>

      {message && <p className="universal-library-message" role="status">{message}</p>}

      <div className="universal-library-source-bar">
        <span>{t('universalLibrary.localReady', { count: localItems.length })}</span>
        <span>{t('universalLibrary.providerReady', { count: searchProviders.length })}</span>
        {!routedMediaProvider && openProviders.length > 1 && (
          <em>{t('universalLibrary.routeRequired')}</em>
        )}
      </div>

      {items.length > 0 ? (
        <div className="universal-library-grid">
          {items.map(item => {
            const thumbnail = item.source === 'provider' ? item.thumbnail : undefined;
            const providerName = item.source === 'provider'
              ? item.providerName
              : t('universalLibrary.liveDropSource');
            const isArmed = armedItemId === item.id;
            const cannotOpenLiveDrop =
              item.source === 'live-drop' && !routedMediaProvider;
            return (
              <article key={item.id} className={`universal-library-card source-${item.source}`}>
                <div className="universal-library-preview">
                  {thumbnail ? (
                    <img src={thumbnail} alt="" />
                  ) : (
                    <span aria-hidden="true">{item.kind.slice(0, 1).toUpperCase()}</span>
                  )}
                  <small>{t(`universalLibrary.kinds.${item.kind}`)}</small>
                </div>
                <div className="universal-library-copy">
                  <strong title={item.name}>{item.name}</strong>
                  <span>{providerName}</span>
                  <small>{metadata(item)}</small>
                </div>
                <div className="universal-library-card-actions">
                  <button
                    type="button"
                    className={isArmed ? 'primary danger-confirm' : 'secondary'}
                    disabled={busyItemId === item.id || cannotOpenLiveDrop}
                    title={cannotOpenLiveDrop ? t('universalLibrary.routeRequired') : undefined}
                    onClick={() => arm(item)}
                  >
                    {busyItemId === item.id
                      ? '…'
                      : isArmed
                        ? t('universalLibrary.confirm')
                        : t('universalLibrary.open')}
                  </button>
                  {servicePlan && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyItemId === item.id}
                        onClick={() => void addToService(item, 'next')}
                      >
                        {t('universalLibrary.addNext')}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyItemId === item.id}
                        onClick={() => void addToService(item, 'end')}
                      >
                        {t('universalLibrary.addEnd')}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="universal-library-empty">
          <strong>{t('universalLibrary.emptyTitle')}</strong>
          <span>{searchProviders.length
            ? t('universalLibrary.emptyHint')
            : t('universalLibrary.noProviderSearch')}</span>
        </div>
      )}
    </section>
  );
}
