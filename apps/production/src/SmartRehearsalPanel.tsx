import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CAPABILITIES,
  rehearseServicePlan,
  type Capability,
  type CapabilitySnapshot,
  type ProviderRouteGroup
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { AiInsightPanel } from './AiInsightPanel';
import { liveFeatureFlags } from './featureFlags';

type Controller = ReturnType<typeof useLiveNode>;

export function SmartRehearsalPanel({
  controller
}: {
  controller: Controller;
}) {
  const { t } = useTranslation();
  const state = controller.nodeState?.state;
  const plan = state?.servicePlan || null;
  const [trainingMode, setTrainingMode] = useState(false);

  const report = useMemo(() => {
    if (!plan || !controller.nodeState) return null;

    const providers: CapabilitySnapshot[] = controller.nodeState.providers.map(provider => ({
      providerId: provider.providerId,
      capabilities: provider.capabilities.filter(
        (capability): capability is Capability =>
          (CAPABILITIES as readonly string[]).includes(capability)
      ),
      health: provider.health as CapabilitySnapshot['health'],
      observed: provider.observed
    }));

    return rehearseServicePlan({
      plan,
      providerLinks: state?.providerLinks || [],
      providers,
      routing: (controller.nodeState.routing || {}) as Partial<Record<ProviderRouteGroup, string>>,
      scenes: state?.scenes || [],
      offlineMedia: (controller.nodeState.liveDrop || []).map(asset => ({
        id: asset.id,
        fileName: asset.fileName,
        sha256: asset.sha256,
        ready: asset.status === 'ready'
      }))
    });
  }, [
    controller.nodeState,
    plan,
    state?.providerLinks,
    state?.scenes,
    controller.nodeState?.liveDrop
  ]);

  if (!report) return null;

  const attention = report.findings.filter(
    finding => finding.severity === 'blocker' || finding.severity === 'warning'
  );

  return (
    <section className={[
      'smart-rehearsal-panel',
      report.safeToArm ? 'ready' : 'blocked'
    ].join(' ')}>
      <header>
        <div>
          <span className="eyebrow">{t('smartRehearsal.kicker')}</span>
          <h2>{t('smartRehearsal.title')}</h2>
          <p>{t('smartRehearsal.description')}</p>
        </div>
        <div className="smart-rehearsal-state">
          <small>{t('smartRehearsal.simulation')}</small>
          <strong>
            {report.safeToArm
              ? t('smartRehearsal.ready')
              : t('smartRehearsal.blocked')}
          </strong>
          <span>{t('smartRehearsal.zeroWrites')}</span>
        </div>
        <button
          type="button"
          className={trainingMode ? 'secondary active' : 'secondary'}
          onClick={() => setTrainingMode(value => !value)}
        >
          {trainingMode
            ? t('smartRehearsal.trainingExit')
            : t('smartRehearsal.trainingStart')}
        </button>
      </header>

      {trainingMode && (
        <div className="smart-rehearsal-training" role="status">
          <div>
            <small>{t('smartRehearsal.trainingKicker')}</small>
            <strong>{t('smartRehearsal.trainingTitle')}</strong>
            <span>{t('smartRehearsal.trainingHint')}</span>
          </div>
          <ol>
            {report.items.map(item => (
              <li key={item.serviceItemId} className={item.ready ? 'ready' : 'attention'}>
                <strong>{item.title}</strong>
                <span>
                  {item.ready
                    ? t('smartRehearsal.trainingReady')
                    : item.findings
                        .filter(finding => finding.severity === 'blocker' || finding.severity === 'warning')
                        .map(finding => finding.message)
                        .join(' · ')}
                </span>
              </li>
            ))}
          </ol>
          <small>{t('smartRehearsal.trainingZeroWrite')}</small>
        </div>
      )}

      <div className="smart-rehearsal-metrics">
        <article>
          <small>{t('smartRehearsal.readyItems')}</small>
          <strong>{report.readyItems}/{report.totalItems}</strong>
        </article>
        <article>
          <small>{t('smartRehearsal.blockers')}</small>
          <strong>{report.blockers}</strong>
        </article>
        <article>
          <small>{t('smartRehearsal.warnings')}</small>
          <strong>{report.warnings}</strong>
        </article>
        <article>
          <small>{t('smartRehearsal.commands')}</small>
          <strong>{report.simulatedCommands}</strong>
        </article>
      </div>

      {liveFeatureFlags.aiAssist && controller.credential?.binding.organizationId && (
        <AiInsightPanel
          organizationId={controller.credential.binding.organizationId}
          task="pre_service_risk_summary"
          input={{
            planId: report.planId,
            revision: report.revision,
            safeToArm: report.safeToArm,
            blockers: report.blockers,
            warnings: report.warnings,
            readyItems: report.readyItems,
            totalItems: report.totalItems,
            findings: attention.map(finding => ({
              severity: finding.severity,
              code: finding.code,
              message: finding.message,
              serviceItemId: finding.serviceItemId,
              providerId: finding.providerId
            }))
          }}
          compact
        />
      )}

      {attention.length === 0 ? (
        <div className="smart-rehearsal-empty">
          <strong>{t('smartRehearsal.noBlockers')}</strong>
          <span>{t('smartRehearsal.noBlockersHint')}</span>
        </div>
      ) : (
        <div className="smart-rehearsal-findings">
          {attention.slice(0, 12).map(finding => (
            <article
              key={finding.id}
              className={`severity-${finding.severity}`}
            >
              <div>
                <small>{t(`smartRehearsal.severity.${finding.severity}`)}</small>
                <strong>{finding.message}</strong>
                {finding.serviceItemId && (
                  <span>{finding.serviceItemId}</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
