import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveStudioFlow } from './studioFlow';

type Destination = 'overview' | 'prepare' | 'library' | 'computers' | 'routing' | 'signal' | 'scenes' | 'diagnostics';

export function StudioGuidedHome({
  nodeConnected,
  providersOnline,
  providersTotal,
  hasScale,
  scaleName,
  scaleSongs,
  scopeMatches,
  hasCachedPlan,
  onOpenSection,
  onOpenLive,
  onResolveScope
}: {
  nodeConnected: boolean;
  providersOnline: number;
  providersTotal: number;
  hasScale: boolean;
  scaleName?: string;
  scaleSongs?: number;
  scopeMatches: boolean;
  hasCachedPlan: boolean;
  onOpenSection: (destination: Destination) => void;
  onOpenLive: (freeMode?: boolean) => void;
  onResolveScope: () => void;
}) {
  const { t } = useTranslation();

  const checks = useMemo(() => [
    {
      key: 'node',
      ready: nodeConnected,
      label: t('guidedHome.checks.node'),
      detail: nodeConnected
        ? t('guidedHome.checks.nodeReady')
        : t('guidedHome.checks.nodePending')
    },
    {
      key: 'providers',
      ready: providersOnline > 0,
      label: t('guidedHome.checks.providers'),
      detail: providersOnline > 0
        ? t('guidedHome.checks.providersReady', {
            online: providersOnline,
            total: providersTotal
          })
        : t('guidedHome.checks.providersPending')
    },
    {
      key: 'service',
      ready: hasScale && scopeMatches && hasCachedPlan,
      softReady: !hasScale && nodeConnected,
      label: t('guidedHome.checks.service'),
      detail: hasScale
        ? !scopeMatches
          ? t('guidedHome.checks.serviceWrongScope')
          : hasCachedPlan
            ? t('guidedHome.checks.serviceReady', { songs: scaleSongs || 0 })
            : t('guidedHome.checks.servicePreparing')
        : t('guidedHome.checks.serviceFree')
    }
  ], [
    hasCachedPlan,
    hasScale,
    nodeConnected,
    providersOnline,
    providersTotal,
    scaleSongs,
    scopeMatches,
    t
  ]);

  const readyCount = checks.filter(item => item.ready || item.softReady).length;

  const flow = useMemo(() => resolveStudioFlow({
    nodeConnected,
    providersOnline,
    hasScale,
    scopeMatches,
    hasCachedPlan
  }), [hasCachedPlan, hasScale, nodeConnected, providersOnline, scopeMatches]);

  const nextAction = useMemo(() => {
    if (flow.step === 'connectNode') {
      return {
        title: t('guidedHome.next.connectNodeTitle'),
        description: t('guidedHome.next.connectNodeDescription'),
        action: t('guidedHome.next.connectNodeAction'),
        run: () => onOpenSection('overview')
      };
    }

    if (flow.step === 'providers') {
      return {
        title: t('guidedHome.next.providersTitle'),
        description: t('guidedHome.next.providersDescription'),
        action: t('guidedHome.next.providersAction'),
        run: () => onOpenSection('diagnostics')
      };
    }

    if (flow.step === 'scope') {
      return {
        title: t('guidedHome.next.scopeTitle'),
        description: t('guidedHome.next.scopeDescription'),
        action: t('guidedHome.next.scopeAction'),
        run: onResolveScope
      };
    }

    if (flow.step === 'prepare') {
      return {
        title: t('guidedHome.next.prepareTitle'),
        description: t('guidedHome.next.prepareDescription'),
        action: t('guidedHome.next.prepareAction'),
        run: () => onOpenSection('prepare')
      };
    }

    if (flow.step === 'live') {
      return {
        title: t('guidedHome.next.liveTitle'),
        description: t('guidedHome.next.liveDescription', {
          service: scaleName || t('guidedHome.serviceFallback')
        }),
        action: t('guidedHome.next.liveAction'),
        run: () => onOpenLive(false)
      };
    }

    return {
      title: t('guidedHome.next.freeTitle'),
      description: t('guidedHome.next.freeDescription'),
      action: t('guidedHome.next.freeAction'),
      run: () => onOpenLive(true)
    };
  }, [flow.step, onOpenLive, onOpenSection, onResolveScope, scaleName, t]);

  return (
    <section className="guided-home">
      <div className="guided-home-main">
        <div className="guided-home-copy">
          <span className="eyebrow">{t('guidedHome.kicker')}</span>
          <h2>{t('guidedHome.title')}</h2>
          <p>{t('guidedHome.description')}</p>
        </div>

        <div className="guided-readiness" aria-label={t('guidedHome.readinessLabel')}>
          <div className="guided-readiness-score">
            <strong>{readyCount}/3</strong>
            <span>{t(readyCount === 3 ? 'guidedHome.ready' : 'guidedHome.inProgress')}</span>
          </div>
          <div className="guided-checks">
            {checks.map(item => (
              <article
                key={item.key}
                className={[
                  'guided-check',
                  item.ready ? 'ready' : item.softReady ? 'soft-ready' : 'pending'
                ].join(' ')}
              >
                <span className="guided-check-mark" aria-hidden="true" />
                <div>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>

      <div className="guided-next-action">
        <div>
          <span>{t('guidedHome.nextLabel')}</span>
          <strong>{nextAction.title}</strong>
          <p>{nextAction.description}</p>
        </div>
        <button type="button" className="primary guided-primary-action" onClick={nextAction.run}>
          {nextAction.action}
        </button>
      </div>

      {nodeConnected && (
        <nav className="guided-shortcuts" aria-label={t('guidedHome.shortcutsLabel')}>
          <button type="button" onClick={() => onOpenSection('prepare')}>
            <span>{t('guidedHome.shortcuts.prepare')}</span>
            <small>{t('guidedHome.shortcuts.prepareHint')}</small>
          </button>
          <button type="button" onClick={() => onOpenSection('library')}>
            <span>{t('guidedHome.shortcuts.library')}</span>
            <small>{t('guidedHome.shortcuts.libraryHint')}</small>
          </button>
          <button type="button" onClick={() => onOpenSection('computers')}>
            <span>{t('guidedHome.shortcuts.computers')}</span>
            <small>{t('guidedHome.shortcuts.computersHint')}</small>
          </button>
          <button type="button" onClick={() => onOpenSection('diagnostics')}>
            <span>{t('guidedHome.shortcuts.health')}</span>
            <small>{t('guidedHome.shortcuts.healthHint')}</small>
          </button>
        </nav>
      )}
    </section>
  );
}
