import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LiveSessionEvent,
  LiveSessionEventSummary
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

function subjectText(event: LiveSessionEvent): string {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  const subject = payload.subject && typeof payload.subject === 'object'
    ? payload.subject as Record<string, unknown>
    : {};

  for (const value of [
    payload.sceneName,
    subject.title,
    subject.name,
    subject.reference,
    subject.references,
    subject.file,
    subject.message
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map(String).join(', ');
  }
  return '';
}

function eventLabelKey(event: LiveSessionEvent): string {
  switch (event.type) {
    case 'song.presented':
      return 'song';
    case 'bible.presented':
      return 'bible';
    case 'media.presented':
      return 'media';
    case 'text.presented':
      return 'text';
    case 'announcement.presented':
      return 'announcement';
    case 'presentation.navigated':
      return 'navigation';
    case 'presentation.cleared':
      return 'clear';
    case 'screen.mode.changed':
      return 'screenMode';
    case 'background.changed':
      return 'background';
    case 'stage.message.sent':
      return 'stageMessage';
    case 'visual.clip.triggered':
      return 'visual';
    case 'visual.layer.cleared':
    case 'visual.composition.cleared':
      return 'visualClear';
    case 'scene.executed':
      return 'scene';
    case 'request.created':
      return 'request';
    case 'request.status.changed':
      return 'requestStatus';
    case 'command.failed':
      return 'failed';
    default:
      return 'command';
  }
}

function eventTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function LiveSessionPulse({
  controller,
  liveSessionId
}: {
  controller: Controller;
  liveSessionId: string;
}) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<LiveSessionEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [eventSummary, setEventSummary] = useState<LiveSessionEventSummary | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const page = await controller.listEvents(liveSessionId, expanded ? 180 : 80);
        if (cancelled) return;
        setEvents(page.events);
        setTotal(page.total);
        setEventSummary(page.summary);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [controller.listEvents, expanded, liveSessionId]);

  const summary = useMemo(() => {
    const plannedTotal = controller.nodeState?.state.servicePlan?.items.length || 0;
    return {
      plannedTouched: eventSummary?.plannedServiceItems || 0,
      plannedTotal,
      adHoc: eventSummary?.adHocActions || 0,
      attention: (eventSummary?.warnings || 0) + (eventSummary?.errors || 0)
    };
  }, [
    controller.nodeState?.state.servicePlan?.items.length,
    eventSummary
  ]);

  const visibleEvents = expanded ? events : events.slice(0, 6);

  return (
    <section className={expanded ? 'live-session-pulse expanded' : 'live-session-pulse'}>
      <header className="live-session-pulse-head">
        <div>
          <span>{t('sessionPulse.kicker')}</span>
          <strong>{t('sessionPulse.title')}</strong>
          <small>{t('sessionPulse.subtitle')}</small>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
        >
          {expanded ? t('sessionPulse.collapse') : t('sessionPulse.expand')}
        </button>
      </header>

      <div className="live-session-pulse-stats">
        <div>
          <small>{t('sessionPulse.actions')}</small>
          <strong>{total}</strong>
        </div>
        <div>
          <small>{t('sessionPulse.planned')}</small>
          <strong>
            {summary.plannedTotal
              ? `${summary.plannedTouched}/${summary.plannedTotal}`
              : '—'}
          </strong>
        </div>
        <div>
          <small>{t('sessionPulse.adHoc')}</small>
          <strong>{summary.adHoc}</strong>
        </div>
        <div className={summary.attention ? 'attention' : ''}>
          <small>{t('sessionPulse.attention')}</small>
          <strong>{summary.attention}</strong>
        </div>
      </div>

      <div className="live-session-event-list" aria-live="polite">
        {visibleEvents.map(event => {
          const subject = subjectText(event);
          const payload = event.payload && typeof event.payload === 'object'
            ? event.payload as Record<string, unknown>
            : {};
          const failedCount = Number(payload.failedCount || 0);

          return (
            <div
              key={event.id}
              className={[
                'live-session-event-row',
                event.level
              ].join(' ')}
            >
              <span className="live-session-event-dot" />
              <div className="live-session-event-copy">
                <strong>{t(`sessionPulse.events.${eventLabelKey(event)}`)}</strong>
                <small>
                  {subject || (
                    event.serviceItemId
                      ? t('sessionPulse.plannedAction')
                      : t('sessionPulse.operationalAction')
                  )}
                </small>
              </div>
              <div className="live-session-event-meta">
                {failedCount > 0 && (
                  <em>{t('sessionPulse.providerAttention', { count: failedCount })}</em>
                )}
                <time dateTime={event.occurredAt}>{eventTime(event.occurredAt)}</time>
              </div>
            </div>
          );
        })}

        {!visibleEvents.length && !loading && !error && (
          <div className="live-session-event-empty">
            <strong>{t('sessionPulse.emptyTitle')}</strong>
            <span>{t('sessionPulse.emptyHint')}</span>
          </div>
        )}

        {loading && !events.length && (
          <div className="live-session-event-empty">
            <span>{t('sessionPulse.loading')}</span>
          </div>
        )}

        {error && !events.length && (
          <div className="live-session-event-empty warning">
            <strong>{t('sessionPulse.unavailableTitle')}</strong>
            <span>{t('sessionPulse.unavailableHint')}</span>
          </div>
        )}
      </div>

      {expanded && total > events.length && (
        <small className="live-session-pulse-retention">
          {t('sessionPulse.showingRecent', { count: events.length, total })}
        </small>
      )}
    </section>
  );
}
