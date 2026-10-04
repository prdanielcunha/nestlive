import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderRouteGroup } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { AiInsightPanel } from './AiInsightPanel';
import { liveFeatureFlags } from './featureFlags';

type Controller = ReturnType<typeof useLiveNode>;

type Severity = 'ok' | 'warning' | 'critical';

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

export function DiagnosticsPanel({
  controller
}: {
  controller: Controller;
}) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const providers = controller.nodeState?.providers || [];
  const peers = controller.nodeState?.peers || [];
  const routing = controller.nodeState?.routing || {};
  const topology = controller.nodeState?.signalTopology;
  const runtime = controller.nodeState?.state;

  const routeDiagnostics = useMemo(() => {
    return ROUTE_GROUPS.map(group => {
      const candidates = providers.filter(provider =>
        provider.capabilities.some(capability => groupForCapability(capability) === group)
      );
      const explicit = routing[group];
      return {
        group,
        candidates,
        ambiguous: candidates.length > 1 && !explicit,
        missing: candidates.length === 0
      };
    });
  }, [providers, routing]);

  const providerOnline = providers.filter(
    provider => provider.health === 'online' || provider.health === 'degraded'
  ).length;
  const providerOffline = providers.length - providerOnline;
  const peerOffline = peers.filter(peer => peer.health === 'offline').length;
  const ambiguousRoutes = routeDiagnostics.filter(route => route.ambiguous).length;
  const enabledEndpoints = topology?.endpoints.filter(endpoint => endpoint.enabled).length || 0;
  const enabledLinks = topology?.links.filter(link => link.enabled).length || 0;
  const hasCachedPlan = Boolean(runtime?.servicePlan);

  const issues = useMemo(() => {
    const next: Array<{
      severity: Exclude<Severity, 'ok'>;
      title: string;
      description: string;
    }> = [];

    if (providers.length === 0) {
      next.push({
        severity: 'critical',
        title: t('diagnostics.issues.noProviders.title'),
        description: t('diagnostics.issues.noProviders.description')
      });
    } else if (providerOffline > 0) {
      next.push({
        severity: 'warning',
        title: t('diagnostics.issues.providersOffline.title', { count: providerOffline }),
        description: t('diagnostics.issues.providersOffline.description')
      });
    }

    if (peerOffline > 0) {
      next.push({
        severity: 'warning',
        title: t('diagnostics.issues.peersOffline.title', { count: peerOffline }),
        description: t('diagnostics.issues.peersOffline.description')
      });
    }

    if (ambiguousRoutes > 0) {
      next.push({
        severity: 'warning',
        title: t('diagnostics.issues.ambiguousRoutes.title', { count: ambiguousRoutes }),
        description: t('diagnostics.issues.ambiguousRoutes.description')
      });
    }

    if (enabledEndpoints > 0 && enabledLinks === 0) {
      next.push({
        severity: 'warning',
        title: t('diagnostics.issues.signalDisconnected.title'),
        description: t('diagnostics.issues.signalDisconnected.description')
      });
    }

    if (!hasCachedPlan) {
      next.push({
        severity: 'warning',
        title: t('diagnostics.issues.noOfflinePlan.title'),
        description: t('diagnostics.issues.noOfflinePlan.description')
      });
    }

    return next;
  }, [
    ambiguousRoutes,
    enabledEndpoints,
    enabledLinks,
    hasCachedPlan,
    peerOffline,
    providerOffline,
    providers.length,
    t
  ]);

  const overall: Severity = issues.some(issue => issue.severity === 'critical')
    ? 'critical'
    : issues.length > 0
      ? 'warning'
      : 'ok';

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await controller.refreshState();
    } finally {
      setRefreshing(false);
    }
  };

  const copyReport = async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      product: 'NestLive',
      node: {
        nodeId: controller.nodeState?.nodeId || null,
        hostname: controller.health?.hostname || null,
        health: controller.health?.health || null,
        providers: controller.health?.providers || 0,
        providersOnline: controller.health?.providersOnline || 0
      },
      providers: providers.map(provider => ({
        providerId: provider.providerId,
        nodeId: provider.nodeId || null,
        displayName: provider.displayName || provider.providerId,
        providerKey: provider.providerKey || null,
        kind: provider.kind || null,
        health: provider.health,
        capabilities: provider.capabilities
      })),
      peers: peers.map(peer => ({
        nodeId: peer.nodeId,
        displayName: peer.displayName,
        health: peer.health,
        providers: peer.providers,
        providersOnline: peer.providersOnline
      })),
      routing,
      signalTopology: topology
        ? {
            revision: topology.revision,
            endpoints: topology.endpoints,
            links: topology.links
          }
        : null,
      runtime: runtime
        ? {
            revision: runtime.revision,
            activeLiveSessionId: runtime.activeLiveSessionId,
            servicePlanId: runtime.servicePlan?.id || null,
            servicePlanItems: runtime.servicePlan?.items.length || 0
          }
        : null,
      issues: issues.map(issue => ({
        severity: issue.severity,
        title: issue.title
      }))
    };

    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const cards = [
    {
      key: 'node',
      severity: 'ok' as Severity,
      value: t('diagnostics.values.localReady'),
      detail: controller.health?.hostname || t('diagnostics.values.thisComputer')
    },
    {
      key: 'providers',
      severity: providers.length === 0
        ? 'critical' as Severity
        : providerOffline > 0
          ? 'warning' as Severity
          : 'ok' as Severity,
      value: `${providerOnline}/${providers.length}`,
      detail: t('diagnostics.values.providersOnline')
    },
    {
      key: 'computers',
      severity: peerOffline > 0 ? 'warning' as Severity : 'ok' as Severity,
      value: String(1 + peers.length),
      detail: peerOffline
        ? t('diagnostics.values.computersOffline', { count: peerOffline })
        : t('diagnostics.values.computersReady')
    },
    {
      key: 'routing',
      severity: ambiguousRoutes > 0 ? 'warning' as Severity : 'ok' as Severity,
      value: ambiguousRoutes > 0
        ? String(ambiguousRoutes)
        : t('diagnostics.values.clear'),
      detail: ambiguousRoutes > 0
        ? t('diagnostics.values.routesNeedChoice')
        : t('diagnostics.values.routesReady')
    },
    {
      key: 'signal',
      severity: enabledEndpoints > 0 && enabledLinks === 0
        ? 'warning' as Severity
        : 'ok' as Severity,
      value: `${enabledEndpoints} · ${enabledLinks}`,
      detail: t('diagnostics.values.signalPointsLinks')
    },
    {
      key: 'offline',
      severity: hasCachedPlan ? 'ok' as Severity : 'warning' as Severity,
      value: hasCachedPlan
        ? t('diagnostics.values.prepared')
        : t('diagnostics.values.freeOnly'),
      detail: hasCachedPlan
        ? t('diagnostics.values.offlinePlanReady')
        : t('diagnostics.values.freeModeStillWorks')
    }
  ];

  return (
    <section className="diagnostics-panel panel">
      <div className="diagnostics-head">
        <div>
          <span className="eyebrow">{t('diagnostics.kicker')}</span>
          <h2>{t('diagnostics.title')}</h2>
          <p>{t('diagnostics.description')}</p>
        </div>
        <div className={`diagnostics-overall ${overall}`}>
          <span className="status-dot" />
          <div>
            <small>{t('diagnostics.overall')}</small>
            <strong>{t(`diagnostics.states.${overall}`)}</strong>
          </div>
        </div>
      </div>

      <div className="diagnostics-grid">
        {cards.map(card => (
          <article key={card.key} className={`diagnostic-card ${card.severity}`}>
            <span className="status-dot" />
            <div>
              <small>{t(`diagnostics.cards.${card.key}`)}</small>
              <strong>{card.value}</strong>
              <em>{card.detail}</em>
            </div>
          </article>
        ))}
      </div>

      <div className="diagnostics-actions">
        <div>
          <strong>{issues.length
            ? t('diagnostics.attentionTitle')
            : t('diagnostics.readyTitle')}</strong>
          <span>{issues.length
            ? t('diagnostics.attentionHint')
            : t('diagnostics.readyHint')}</span>
        </div>
        <div>
          <button
            type="button"
            className="ghost"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? t('diagnostics.refreshing') : t('diagnostics.refresh')}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void copyReport()}
          >
            {copied ? t('diagnostics.copied') : t('diagnostics.copyReport')}
          </button>
        </div>
      </div>

      {liveFeatureFlags.aiAssist && controller.credential?.binding.organizationId && (
        <AiInsightPanel
          organizationId={controller.credential.binding.organizationId}
          task="diagnostic_explanation"
          input={{
            node: {
              health: controller.health?.health || null,
              providers: providers.length,
              providersOnline: providerOnline,
              peerOffline,
              ambiguousRoutes,
              hasCachedPlan
            },
            issues: issues.map(issue => ({
              severity: issue.severity,
              title: issue.title,
              description: issue.description
            })),
            routing,
            signal: {
              enabledEndpoints,
              enabledLinks
            }
          }}
        />
      )}

      {issues.length > 0 && (
        <div className="diagnostic-issues">
          {issues.map((issue, index) => (
            <article key={`${issue.title}-${index}`} className={issue.severity}>
              <span className="status-dot" />
              <div>
                <strong>{issue.title}</strong>
                <p>{issue.description}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
