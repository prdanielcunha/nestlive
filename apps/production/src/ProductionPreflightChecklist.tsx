import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { useLiveNode } from './useLiveNode';
import {
  buildProductionReadinessChecks,
  hasBlockingReadiness,
  type ProductionReadinessCheck
} from './preflightReadiness';

type Controller = ReturnType<typeof useLiveNode>;

function outputCount(results: Awaited<ReturnType<Controller['executeCommand']>>): number {
  return results.reduce((total, result) => {
    const value = result.observedState?.outputs;
    return total + (Array.isArray(value) ? value.length : 0);
  }, 0);
}

export function ProductionPreflightChecklist({
  controller,
  actorId,
  liveSessionId,
  scaleHasSongs,
  onBlockingChange
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
  scaleHasSongs: boolean;
  onBlockingChange?: (blocked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const [visualOutputCheck, setVisualOutputCheck] = useState<ProductionReadinessCheck | null>(null);
  const visualProbeSignature = useRef('');

  const staticChecks = useMemo(
    () => controller.nodeState
      ? buildProductionReadinessChecks(controller.nodeState, scaleHasSongs)
      : [],
    [controller.nodeState, scaleHasSongs]
  );

  const providersById = useMemo(
    () => new Map(
      (controller.nodeState?.providers || []).map(provider => [
        provider.providerId,
        provider
      ])
    ),
    [controller.nodeState?.providers]
  );

  const visualProvider = useMemo(() => {
    const providers = (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('visual.outputs.read')
    );
    const routed = controller.nodeState?.routing?.visual;
    if (routed) {
      return providers.find(provider => provider.providerId === routed) || null;
    }
    return providers.length === 1 ? providers[0]! : null;
  }, [controller.nodeState]);

  async function probeVisualOutputs(force = false) {
    if (!visualProvider) {
      setVisualOutputCheck(null);
      return;
    }

    const signature = [
      visualProvider.providerId,
      visualProvider.health
    ].join(':');

    if (!force && visualProbeSignature.current === signature) return;
    visualProbeSignature.current = signature;

    setVisualOutputCheck({
      id: 'visual-outputs',
      level: 'warning',
      code: 'visual_outputs_checking',
      providerId: visualProvider.providerId
    });

    try {
      const results = await controller.executeCommand({
        capability: 'visual.outputs.read',
        payload: {},
        targetProviderIds: [visualProvider.providerId],
        liveSessionId,
        actorId,
        safetyLevel: 'normal'
      });
      const accepted = results.some(result => result.accepted);
      const count = outputCount(results);
      setVisualOutputCheck({
        id: 'visual-outputs',
        level: accepted && count > 0 ? 'pass' : 'warning',
        code: accepted && count > 0
          ? 'visual_outputs_ready'
          : accepted
            ? 'visual_outputs_empty'
            : 'visual_outputs_unavailable',
        count,
        providerId: visualProvider.providerId
      });
    } catch {
      setVisualOutputCheck({
        id: 'visual-outputs',
        level: 'warning',
        code: 'visual_outputs_unavailable',
        providerId: visualProvider.providerId
      });
    }
  }

  useEffect(() => {
    void probeVisualOutputs();
    // Probe is keyed by provider/state revision and intentionally read-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualProvider?.providerId, visualProvider?.health]);

  const checks = useMemo(
    () => visualOutputCheck
      ? [...staticChecks, visualOutputCheck]
      : staticChecks,
    [staticChecks, visualOutputCheck]
  );

  const summary = useMemo(() => ({
    pass: checks.filter(check => check.level === 'pass').length,
    warning: checks.filter(check => check.level === 'warning').length,
    block: checks.filter(check => check.level === 'block').length
  }), [checks]);

  const blocked = hasBlockingReadiness(checks);

  useEffect(() => {
    onBlockingChange?.(blocked);
  }, [blocked, onBlockingChange]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await controller.refreshState();
      visualProbeSignature.current = '';
      await probeVisualOutputs(true);
    } finally {
      setRefreshing(false);
    }
  }

  if (!controller.nodeState) return null;

  return (
    <section className={blocked ? 'production-preflight blocked' : 'production-preflight'}>
      <header className="production-preflight-head">
        <div>
          <span>{t('productionPreflight.kicker')}</span>
          <strong>{t('productionPreflight.title')}</strong>
          <small>{t('productionPreflight.subtitle')}</small>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? '…' : t('productionPreflight.recheck')}
        </button>
      </header>

      <div className="production-preflight-summary">
        <div className="pass">
          <small>{t('productionPreflight.ready')}</small>
          <strong>{summary.pass}</strong>
        </div>
        <div className={summary.warning ? 'warning' : ''}>
          <small>{t('productionPreflight.warnings')}</small>
          <strong>{summary.warning}</strong>
        </div>
        <div className={summary.block ? 'block' : ''}>
          <small>{t('productionPreflight.blocking')}</small>
          <strong>{summary.block}</strong>
        </div>
        <div className={blocked ? 'gate block' : 'gate pass'}>
          <small>{t('productionPreflight.gate')}</small>
          <strong>
            {blocked
              ? t('productionPreflight.resolveBeforeLive')
              : t('productionPreflight.safeToStart')}
          </strong>
        </div>
      </div>

      <div className="production-preflight-checks">
        {checks.map(check => {
          const provider = check.providerId
            ? providersById.get(check.providerId)
            : null;
          return (
            <article
              key={check.id}
              className={`production-preflight-check ${check.level}`}
            >
              <span className="production-preflight-dot" aria-hidden="true" />
              <div>
                <strong>
                  {t(`productionPreflight.checks.${check.code}.title`, {
                    count: check.count || 0,
                    defaultValue: check.code
                  })}
                </strong>
                <small>
                  {t(`productionPreflight.checks.${check.code}.hint`, {
                    count: check.count || 0,
                    provider:
                      provider?.displayName ||
                      provider?.providerKey ||
                      check.providerId ||
                      '',
                    defaultValue: ''
                  })}
                </small>
              </div>
              <em>
                {check.level === 'pass'
                  ? t('productionPreflight.status.pass')
                  : check.level === 'warning'
                    ? t('productionPreflight.status.warning')
                    : t('productionPreflight.status.block')}
              </em>
            </article>
          );
        })}

        {!checks.length && (
          <div className="production-preflight-empty">
            <strong>{t('productionPreflight.noRequirements')}</strong>
            <span>{t('productionPreflight.noRequirementsHint')}</span>
          </div>
        )}
      </div>

      <footer>
        <span>{t('productionPreflight.footer')}</span>
      </footer>
    </section>
  );
}
