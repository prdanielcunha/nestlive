import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildNextServicePlanDraft,
  buildServiceReview,
  type LiveSessionEvent,
  type ServiceReviewReport
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { AiInsightPanel } from './AiInsightPanel';
import { liveFeatureFlags } from './featureFlags';

type Controller = ReturnType<typeof useLiveNode>;

export function ServiceReviewPanel({
  controller,
  liveSessionId
}: {
  controller: Controller;
  liveSessionId: string;
}) {
  const { t } = useTranslation();
  const plan = controller.nodeState?.state.servicePlan || null;
  const [events, setEvents] = useState<LiveSessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextScheduledAt, setNextScheduledAt] = useState('');
  const [nextTitle, setNextTitle] = useState('');
  const [preparingNext, setPreparingNext] = useState(false);
  const [nextPrepared, setNextPrepared] = useState(false);

  const refresh = useCallback(async () => {
    if (!plan || !liveSessionId) return;
    setLoading(true);
    setError(null);
    try {
      const page = await controller.listEvents(liveSessionId, 250);
      setEvents(page.events);
      setLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'service_review_failed');
    } finally {
      setLoading(false);
    }
  }, [controller.listEvents, liveSessionId, plan?.id, plan?.revision]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const report: ServiceReviewReport | null = useMemo(() => {
    if (!plan || !loaded) return null;
    return buildServiceReview({
      plan,
      events,
      liveSessionId
    });
  }, [events, liveSessionId, loaded, plan]);

  if (!plan) return null;

  async function prepareNextService() {
    if (!nextScheduledAt || preparingNext || controller.nodeState?.state.activeLiveSessionId) return;
    const localDate = new Date(nextScheduledAt);
    if (!Number.isFinite(localDate.getTime())) {
      setError('next_service_invalid_date');
      return;
    }

    setPreparingNext(true);
    setNextPrepared(false);
    setError(null);
    try {
      const id = `next:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
      const next = buildNextServicePlanDraft({
        previous: plan!,
        id,
        scheduledAt: localDate.toISOString(),
        title: nextTitle.trim() || plan!.title
      });
      await controller.cacheServicePlan(
        next,
        controller.nodeState?.state.providerLinks || []
      );
      setNextPrepared(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'next_service_prepare_failed');
    } finally {
      setPreparingNext(false);
    }
  }

  const formatDuration = (seconds?: number) => {
    if (typeof seconds !== 'number') return '—';
    const absolute = Math.abs(Math.round(seconds));
    const minutes = Math.floor(absolute / 60);
    const remainder = absolute % 60;
    return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
  };

  return (
    <section className="service-review-panel">
      <header>
        <div>
          <span className="eyebrow">{t('serviceReview.kicker')}</span>
          <h2>{t('serviceReview.title')}</h2>
          <p>{t('serviceReview.description')}</p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? t('serviceReview.refreshing') : t('serviceReview.refresh')}
        </button>
      </header>

      {error && (
        <div className="service-review-error" role="status">
          <strong>{t('serviceReview.errorTitle')}</strong>
          <span>{error}</span>
        </div>
      )}

      {!report ? (
        <div className="service-review-loading" role="status">
          {t('serviceReview.loading')}
        </div>
      ) : (
        <>
          <div className="service-review-metrics">
            <article>
              <small>{t('serviceReview.executed')}</small>
              <strong>{report.executedPlannedItems}/{report.plannedItems}</strong>
            </article>
            <article>
              <small>{t('serviceReview.skipped')}</small>
              <strong>{report.explicitlySkippedItems}</strong>
            </article>
            <article>
              <small>{t('serviceReview.adHoc')}</small>
              <strong>{report.adHocRunOfShowActions}</strong>
            </article>
            <article>
              <small>{t('serviceReview.failures')}</small>
              <strong>{report.errorEvents}</strong>
            </article>
            <article>
              <small>{t('serviceReview.requests')}</small>
              <strong>{report.requestSummary.created}</strong>
            </article>
            <article>
              <small>{t('serviceReview.p95')}</small>
              <strong>
                {typeof report.providerLatency.p95Ms === 'number'
                  ? `${Math.round(report.providerLatency.p95Ms)} ms`
                  : '—'}
              </strong>
            </article>
            <article>
              <small>{t('serviceReview.plannedDuration')}</small>
              <strong>{formatDuration(report.plannedDurationSeconds)}</strong>
            </article>
            <article>
              <small>{t('serviceReview.observedDuration')}</small>
              <strong>{formatDuration(report.observedRunOfShowDurationSeconds)}</strong>
            </article>
          </div>

          <div className="service-review-grid">
            <article className="service-review-block">
              <div className="service-review-block-head">
                <div>
                  <small>{t('serviceReview.planComparisonKicker')}</small>
                  <strong>{t('serviceReview.planComparison')}</strong>
                </div>
                <span>{t('serviceReview.notObservedNeutral')}</span>
              </div>
              <div className="service-review-items">
                {report.items.map(item => (
                  <div key={item.serviceItemId} className={`status-${item.status}`}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.type} · {item.serviceItemId}</small>
                      {(typeof item.plannedDurationSeconds === 'number' || typeof item.observedWindowSeconds === 'number') && (
                        <small>
                          {t('serviceReview.durationLine', {
                            planned: formatDuration(item.plannedDurationSeconds),
                            observed: formatDuration(item.observedWindowSeconds),
                            delta: typeof item.durationDeltaSeconds === 'number'
                              ? `${item.durationDeltaSeconds >= 0 ? '+' : '−'}${formatDuration(Math.abs(item.durationDeltaSeconds))}`
                              : '—'
                          })}
                        </small>
                      )}
                    </div>
                    <span>{t(`serviceReview.itemStatus.${item.status}`)}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="service-review-block">
              <div className="service-review-block-head">
                <div>
                  <small>{t('serviceReview.attentionKicker')}</small>
                  <strong>{t('serviceReview.attention')}</strong>
                </div>
              </div>

              {report.failures.length === 0 && report.adHoc.length === 0 && report.corrections.length === 0 ? (
                <div className="service-review-empty">
                  <strong>{t('serviceReview.noAttention')}</strong>
                  <span>{t('serviceReview.noAttentionHint')}</span>
                </div>
              ) : (
                <div className="service-review-attention">
                  {report.failures.slice(0, 8).map(failure => (
                    <div key={failure.eventId} className="failure">
                      <small>{t('serviceReview.failure')}</small>
                      <strong>{failure.type}</strong>
                      <span>
                        {failure.errorCodes.length
                          ? failure.errorCodes.join(', ')
                          : failure.correlationId}
                      </span>
                    </div>
                  ))}
                  {report.adHoc.slice(0, 8).map(entry => (
                    <div key={entry.eventId} className="adhoc">
                      <small>{t('serviceReview.adHocAction')}</small>
                      <strong>{entry.title || entry.type}</strong>
                      <span>{entry.type}</span>
                    </div>
                  ))}
                  {report.corrections.slice(0, 8).map(correction => (
                    <div key={correction.id} className="correction">
                      <small>{t('serviceReview.correction')}</small>
                      <strong>{correction.title}</strong>
                      <span>{correction.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </div>

          <section className="service-review-next">
            <div>
              <small>{t('serviceReview.nextKicker')}</small>
              <strong>{t('serviceReview.nextTitle')}</strong>
              <span>{t('serviceReview.nextHint')}</span>
            </div>
            <div className="service-review-next-fields">
              <label>
                <span>{t('serviceReview.nextName')}</span>
                <input
                  value={nextTitle}
                  onChange={event => {
                    setNextTitle(event.target.value);
                    setNextPrepared(false);
                  }}
                  placeholder={plan.title}
                />
              </label>
              <label>
                <span>{t('serviceReview.nextDate')}</span>
                <input
                  type="datetime-local"
                  value={nextScheduledAt}
                  onChange={event => {
                    setNextScheduledAt(event.target.value);
                    setNextPrepared(false);
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={
                  !nextScheduledAt ||
                  preparingNext ||
                  Boolean(controller.nodeState?.state.activeLiveSessionId)
                }
                onClick={() => void prepareNextService()}
              >
                {preparingNext
                  ? t('serviceReview.nextPreparing')
                  : t('serviceReview.nextPrepare')}
              </button>
            </div>
            {controller.nodeState?.state.activeLiveSessionId && (
              <small className="service-review-next-note">
                {t('serviceReview.nextBlockedDuringLive')}
              </small>
            )}
            {nextPrepared && (
              <small className="service-review-next-success">
                {t('serviceReview.nextPrepared')}
              </small>
            )}
          </section>

          {liveFeatureFlags.aiAssist && controller.credential?.binding.organizationId && (
            <AiInsightPanel
              organizationId={controller.credential.binding.organizationId}
              task="post_service_summary"
              input={{
                planId: report.planId,
                revision: report.revision,
                plannedItems: report.plannedItems,
                executedPlannedItems: report.executedPlannedItems,
                explicitlySkippedItems: report.explicitlySkippedItems,
                notObservedItems: report.notObservedItems,
                adHocRunOfShowActions: report.adHocRunOfShowActions,
                warningEvents: report.warningEvents,
                errorEvents: report.errorEvents,
                requestSummary: report.requestSummary,
                providerLatency: report.providerLatency,
                failures: report.failures,
                factsOnly: report.factsOnly
              }}
              compact
            />
          )}

          <footer className="service-review-facts">
            {t('serviceReview.factsOnly')}
          </footer>
        </>
      )}
    </section>
  );
}
