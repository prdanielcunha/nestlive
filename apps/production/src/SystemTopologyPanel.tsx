import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderRouteGroup } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

const ROUTE_GROUPS: ProviderRouteGroup[] = [
  'presentation',
  'songs',
  'bible',
  'media',
  'stage',
  'visual',
  'audio',
  'automation'
];

function groupForCapability(capability: string): ProviderRouteGroup {
  if (capability.startsWith('presentation.') || capability === 'preview.snapshot') {
    return 'presentation';
  }
  if (capability.startsWith('songs.') || capability.startsWith('playlist.')) return 'songs';
  if (capability.startsWith('bible.')) return 'bible';
  if (capability.startsWith('media.')) return 'media';
  if (capability.startsWith('stage.')) return 'stage';
  if (capability.startsWith('visual.')) return 'visual';
  if (capability.startsWith('audio.')) return 'audio';
  return 'automation';
}

export function SystemTopologyPanel({
  controller
}: {
  controller: Controller;
}) {
  const { t } = useTranslation();
  const [savingRoute, setSavingRoute] = useState<ProviderRouteGroup | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);

  const providers = controller.nodeState?.providers || [];
  const peers = controller.nodeState?.peers || [];
  const routing = controller.nodeState?.routing || {};
  const localNodeId = controller.nodeState?.nodeId || '';

  const providerGroups = useMemo(
    () => providers.map(provider => ({
      ...provider,
      groups: [...new Set(provider.capabilities.map(groupForCapability))]
    })),
    [providers]
  );

  const nodeNames = useMemo(() => {
    const values = new Map<string, string>();
    if (localNodeId) {
      values.set(
        localNodeId,
        controller.health?.hostname || t('topology.thisComputer')
      );
    }
    for (const peer of peers) {
      values.set(peer.nodeId, peer.displayName || peer.nodeId);
    }
    return values;
  }, [controller.health?.hostname, localNodeId, peers, t]);

  const routeRows = useMemo(
    () => ROUTE_GROUPS.map(group => {
      const candidates = providerGroups.filter(provider =>
        provider.groups.includes(group)
      );
      const routedId = routing[group] || null;
      const routed = routedId
        ? providerGroups.find(provider => provider.providerId === routedId) || null
        : candidates.length === 1
          ? candidates[0]
          : null;

      return {
        group,
        candidates,
        routed,
        ambiguous: candidates.length > 1 && !routedId
      };
    }).filter(row => row.candidates.length > 0),
    [providerGroups, routing]
  );

  const ambiguousCount = routeRows.filter(row => row.ambiguous).length;

  const saveRoute = async (
    group: ProviderRouteGroup,
    providerId: string | null
  ) => {
    if (savingRoute) return;
    setSavingRoute(group);
    setRouteError(null);
    try {
      await controller.setProviderRoute(group, providerId);
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : 'route_save_failed');
    } finally {
      setSavingRoute(null);
    }
  };

  return (
    <section className="system-topology">
      <div className="system-topology-head">
        <div>
          <span className="eyebrow">{t('topology.kicker')}</span>
          <h2>{t('topology.title')}</h2>
          <p>{t('topology.description')}</p>
        </div>
        <div className={`topology-readiness ${ambiguousCount ? 'warn' : 'ok'}`}>
          <span />
          <div>
            <small>{t('topology.readiness')}</small>
            <strong>
              {ambiguousCount
                ? t('topology.needsRouting', { count: ambiguousCount })
                : t('topology.ready')}
            </strong>
          </div>
        </div>
      </div>

      <div className="topology-map">
        <div className="topology-nodes">
          <article className="topology-node-card local">
            <small>{t('topology.coordinator')}</small>
            <strong>{controller.health?.hostname || t('topology.thisComputer')}</strong>
            <span>{localNodeId || '—'}</span>
            <em>{t('topology.localControl')}</em>
          </article>

          {peers.map(peer => (
            <article
              key={peer.nodeId}
              className={`topology-node-card peer ${peer.health}`}
            >
              <small>{t('topology.remoteNode')}</small>
              <strong>{peer.displayName || peer.nodeId}</strong>
              <span>{peer.providersOnline}/{peer.providers} {t('topology.providerCount')}</span>
              <em>{peer.health === 'online'
                ? t('topology.peerOnline')
                : peer.health === 'degraded'
                  ? t('topology.peerDegraded')
                  : t('topology.peerOffline')}</em>
            </article>
          ))}
        </div>

        <div className="topology-rail" aria-hidden="true"><span /></div>

        <div className="topology-providers">
          {providerGroups.map(provider => {
            const providerNode = provider.nodeId || localNodeId;
            return (
              <article
                key={provider.providerId}
                className={`topology-provider ${provider.health}`}
              >
                <div className="topology-provider-title">
                  <span className="status-dot" />
                  <div>
                    <strong>{provider.displayName || provider.providerId}</strong>
                    <small>{provider.health}</small>
                  </div>
                </div>
                <span className="topology-provider-node">
                  {nodeNames.get(providerNode) || providerNode || t('topology.unknownComputer')}
                </span>
                <div className="topology-provider-groups">
                  {provider.groups.map(group => (
                    <span key={group}>{t(`topology.groups.${group}`)}</span>
                  ))}
                </div>
              </article>
            );
          })}
          {!providerGroups.length && (
            <div className="topology-empty">{t('topology.noProviders')}</div>
          )}
        </div>
      </div>

      {!!routeRows.length && (
        <div className="topology-routes">
          <div className="topology-routes-head">
            <strong>{t('topology.routes')}</strong>
            <small>{t('topology.routesHint')}</small>
          </div>
          <div className="topology-route-grid">
            {routeRows.map(row => (
              <div
                key={row.group}
                className={`topology-route ${row.ambiguous ? 'ambiguous' : ''}`}
              >
                <span>{t(`topology.groups.${row.group}`)}</span>
                <b>→</b>
                {row.candidates.length > 1 ? (
                  <select
                    aria-label={t('topology.routeSelectLabel', {
                      group: t(`topology.groups.${row.group}`)
                    })}
                    value={routing[row.group] || ''}
                    disabled={savingRoute !== null}
                    onChange={event =>
                      void saveRoute(row.group, event.target.value || null)
                    }
                  >
                    <option value="">{t('topology.choosePrimary')}</option>
                    {row.candidates.map(candidate => {
                      const candidateNode = candidate.nodeId || localNodeId;
                      const nodeName = nodeNames.get(candidateNode);
                      return (
                        <option key={candidate.providerId} value={candidate.providerId}>
                          {candidate.displayName || candidate.providerId}
                          {nodeName ? ` · ${nodeName}` : ''}
                        </option>
                      );
                    })}
                  </select>
                ) : (
                  <strong>
                    {row.routed?.displayName || row.routed?.providerId || t('topology.choosePrimary')}
                  </strong>
                )}
                {row.candidates.length > 1 && (
                  <small>
                    {savingRoute === row.group
                      ? t('topology.savingRoute')
                      : row.ambiguous
                        ? t('topology.multipleCandidates', { count: row.candidates.length })
                        : t('topology.explicitRoute')}
                  </small>
                )}
              </div>
            ))}
          </div>
          {routeError && (
            <div className="topology-route-error">
              {t('topology.routeSaveFailed', { code: routeError })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
