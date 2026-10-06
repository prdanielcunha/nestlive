import type {
  LiveRequestStatus,
  LiveSessionEvent,
  ServiceItem,
  ServicePlan
} from './types';
import { normalizeLiveRequestStatus } from './requestWorkflow';

const RUN_OF_SHOW_EVENT_TYPES = new Set([
  'song.presented',
  'bible.presented',
  'media.presented',
  'text.presented',
  'announcement.presented',
  'presentation.taken',
  'scene.executed'
]);

export type PlannedItemReviewStatus =
  | 'executed'
  | 'skipped'
  | 'not-observed';

export interface PlannedItemReview {
  serviceItemId: string;
  title: string;
  type: ServiceItem['type'];
  plannedState: ServiceItem['state'];
  status: PlannedItemReviewStatus;
  executionEvents: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  plannedDurationSeconds?: number;
  observedWindowSeconds?: number;
  durationDeltaSeconds?: number;
}

export interface ActualRunOfShowEntry {
  eventId: string;
  type: string;
  occurredAt: string;
  correlationId: string;
  serviceItemId?: string;
  title?: string;
  origin?: LiveSessionEvent['origin'];
}

export interface ServiceReviewFailure {
  eventId: string;
  occurredAt: string;
  type: string;
  correlationId: string;
  serviceItemId?: string;
  providerIds: string[];
  errorCodes: string[];
}

export interface ServiceReviewCorrection {
  id: string;
  code:
    | 'review_provider_failure'
    | 'check_provider_connection'
    | 'review_provider_latency';
  title: string;
  reason: string;
  serviceItemId?: string;
  providerId?: string;
  errorCode?: string;
}

export interface ServiceReviewRequestSummary {
  created: number;
  sent: number;
  seen: number;
  accepted: number;
  prepared: number;
  executed: number;
  rejected: number;
  /** @deprecated compatibility alias for pre-Phase-7 reports. */
  completed: number;
  latestStatusByRequest: Record<string, LiveRequestStatus>;
}

export interface ServiceReviewLatency {
  samples: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
}

export interface ServiceReviewReport {
  planId: string;
  revision: number;
  generatedAt: string;
  liveSessionId?: string;
  plannedItems: number;
  executedPlannedItems: number;
  explicitlySkippedItems: number;
  notObservedItems: number;
  adHocRunOfShowActions: number;
  warningEvents: number;
  errorEvents: number;
  plannedDurationSeconds?: number;
  observedRunOfShowDurationSeconds?: number;
  requestSummary: ServiceReviewRequestSummary;
  providerLatency: ServiceReviewLatency;
  items: PlannedItemReview[];
  adHoc: ActualRunOfShowEntry[];
  failures: ServiceReviewFailure[];
  corrections: ServiceReviewCorrection[];
  originCounts: Record<string, number>;
  eventTypeCounts: Record<string, number>;
  factsOnly: true;
}

function eventPayload(event: LiveSessionEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
}

function compactTitle(event: LiveSessionEvent): string | undefined {
  const payload = eventPayload(event);
  const subject =
    payload.subject && typeof payload.subject === 'object'
      ? payload.subject as Record<string, unknown>
      : {};
  for (const key of ['title', 'name', 'reference', 'text']) {
    const value = subject[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 160);
    }
  }
  return undefined;
}

function percentile(values: number[], quantile: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  );
  return sorted[index];
}

function secondsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return undefined;
  }
  return Math.round((endMs - startMs) / 1000);
}

function providerFacts(event: LiveSessionEvent): Array<{
  providerId: string;
  accepted: boolean;
  latencyMs?: number;
  errorCode?: string;
}> {
  const payload = eventPayload(event);
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  return providers.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (typeof item.providerId !== 'string' || typeof item.accepted !== 'boolean') {
      return [];
    }
    return [{
      providerId: item.providerId,
      accepted: item.accepted,
      latencyMs:
        typeof item.latencyMs === 'number' && Number.isFinite(item.latencyMs)
          ? Math.max(0, item.latencyMs)
          : undefined,
      errorCode:
        typeof item.errorCode === 'string' && item.errorCode.trim()
          ? item.errorCode.trim()
          : undefined
    }];
  });
}

function reviewRequests(events: LiveSessionEvent[]): ServiceReviewRequestSummary {
  const latestStatusByRequest: Record<string, LiveRequestStatus> = {};
  let created = 0;

  const chronological = events
    .filter(event =>
      event.type === 'request.created' ||
      event.type === 'request.status.changed'
    )
    .slice()
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  for (const event of chronological) {
    const payload = eventPayload(event);
    const requestId =
      typeof payload.requestId === 'string' ? payload.requestId : event.correlationId;
    if (!requestId) continue;
    if (event.type === 'request.created') created += 1;
    latestStatusByRequest[requestId] = normalizeLiveRequestStatus(payload.status);
  }

  const statuses = Object.values(latestStatusByRequest);
  const count = (status: LiveRequestStatus) =>
    statuses.filter(value => value === status).length;
  const executed = count('executed');

  return {
    created,
    sent: count('sent'),
    seen: count('seen'),
    accepted: count('accepted'),
    prepared: count('prepared'),
    executed,
    rejected: count('rejected'),
    completed: executed,
    latestStatusByRequest
  };
}

function correctionForFailure(
  failure: ServiceReviewFailure
): ServiceReviewCorrection {
  const timeoutCode = failure.errorCodes.find(code => /timeout|unreachable|offline|connection/i.test(code));
  if (timeoutCode) {
    return {
      id: `correction:${failure.eventId}:connection`,
      code: 'check_provider_connection',
      title: 'Review provider connection',
      reason: `Observed failure ${timeoutCode}. Check the affected provider and local network path before the next service.`,
      serviceItemId: failure.serviceItemId,
      providerId: failure.providerIds[0],
      errorCode: timeoutCode
    };
  }

  return {
    id: `correction:${failure.eventId}:provider`,
    code: 'review_provider_failure',
    title: 'Review provider failure',
    reason: failure.errorCodes.length
      ? `Observed provider error: ${failure.errorCodes.join(', ')}.`
      : `Observed ${failure.type} as an error event.`,
    serviceItemId: failure.serviceItemId,
    providerId: failure.providerIds[0],
    errorCode: failure.errorCodes[0]
  };
}

export function buildNextServicePlanDraft(input: {
  previous: ServicePlan;
  id: string;
  scheduledAt: string;
  title?: string;
  now?: Date;
}): ServicePlan {
  const generatedAt = (input.now || new Date()).toISOString();
  const id = input.id.trim();
  if (!id) throw new Error('next_service_plan_id_required');
  if (!input.scheduledAt.trim()) throw new Error('next_service_scheduled_at_required');

  return {
    ...input.previous,
    id,
    title: input.title?.trim() || input.previous.title,
    scheduledAt: input.scheduledAt,
    sourceMusicScaleId: undefined,
    revision: 1,
    metadata: {
      ...(input.previous.metadata || {}),
      clonedFromPlanId: input.previous.id,
      clonedFromRevision: input.previous.revision,
      clonedAt: generatedAt
    },
    items: input.previous.items.map((item, index) => ({
      ...item,
      id: `${id}:item:${index + 1}`,
      state: 'planned'
    }))
  };
}

export function buildServiceReview(input: {
  plan: ServicePlan;
  events: LiveSessionEvent[];
  liveSessionId?: string;
  now?: Date;
}): ServiceReviewReport {
  const scopedEvents = input.events
    .filter(event => !input.liveSessionId || event.liveSessionId === input.liveSessionId)
    .slice()
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const byItem = new Map<string, LiveSessionEvent[]>();
  const adHoc: ActualRunOfShowEntry[] = [];
  const failures: ServiceReviewFailure[] = [];
  const eventTypeCounts: Record<string, number> = {};
  const originCounts: Record<string, number> = {};
  const latencies: number[] = [];

  for (const event of scopedEvents) {
    eventTypeCounts[event.type] = (eventTypeCounts[event.type] || 0) + 1;
    if (event.origin) {
      originCounts[event.origin] = (originCounts[event.origin] || 0) + 1;
    }

    if (event.serviceItemId) {
      const existing = byItem.get(event.serviceItemId) || [];
      existing.push(event);
      byItem.set(event.serviceItemId, existing);
    }

    const payload = eventPayload(event);
    if (
      RUN_OF_SHOW_EVENT_TYPES.has(event.type) &&
      (payload.adHoc === true || !event.serviceItemId) &&
      event.level !== 'error'
    ) {
      adHoc.push({
        eventId: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        serviceItemId: event.serviceItemId,
        title: compactTitle(event),
        origin: event.origin
      });
    }

    const providerResults = providerFacts(event);
    for (const result of providerResults) {
      if (typeof result.latencyMs === 'number') latencies.push(result.latencyMs);
    }

    if (event.level === 'error' || providerResults.some(result => !result.accepted)) {
      failures.push({
        eventId: event.id,
        occurredAt: event.occurredAt,
        type: event.type,
        correlationId: event.correlationId,
        serviceItemId: event.serviceItemId,
        providerIds: providerResults
          .filter(result => !result.accepted)
          .map(result => result.providerId),
        errorCodes: providerResults
          .filter(result => !result.accepted && result.errorCode)
          .map(result => result.errorCode!)
      });
    }
  }

  const items: PlannedItemReview[] = input.plan.items.map(item => {
    const allItemEvents = (byItem.get(item.id) || [])
      .filter(event => event.level !== 'error')
      .slice()
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const executionEvents = allItemEvents.filter(event =>
      RUN_OF_SHOW_EVENT_TYPES.has(event.type)
    );
    const status: PlannedItemReviewStatus =
      item.state === 'skipped'
        ? 'skipped'
        : executionEvents.length
          ? 'executed'
          : 'not-observed';

    const observedWindowSeconds = allItemEvents.length >= 2
      ? secondsBetween(
          allItemEvents[0]?.occurredAt,
          allItemEvents[allItemEvents.length - 1]?.occurredAt
        )
      : undefined;
    const durationDeltaSeconds =
      typeof item.plannedDurationSeconds === 'number' &&
      typeof observedWindowSeconds === 'number'
        ? observedWindowSeconds - item.plannedDurationSeconds
        : undefined;

    return {
      serviceItemId: item.id,
      title: item.title,
      type: item.type,
      plannedState: item.state,
      status,
      executionEvents: executionEvents.length,
      firstObservedAt: allItemEvents[0]?.occurredAt,
      lastObservedAt: allItemEvents[allItemEvents.length - 1]?.occurredAt,
      plannedDurationSeconds: item.plannedDurationSeconds,
      observedWindowSeconds,
      durationDeltaSeconds
    };
  });

  const runOfShowEvents = scopedEvents.filter(event =>
    RUN_OF_SHOW_EVENT_TYPES.has(event.type) && event.level !== 'error'
  );
  const plannedDurationValues = input.plan.items
    .map(item => item.plannedDurationSeconds)
    .filter((value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    );
  const plannedDurationSeconds = plannedDurationValues.length
    ? Math.round(plannedDurationValues.reduce((sum, value) => sum + value, 0))
    : undefined;
  const observedRunOfShowDurationSeconds = runOfShowEvents.length >= 2
    ? secondsBetween(
        runOfShowEvents[0]?.occurredAt,
        runOfShowEvents[runOfShowEvents.length - 1]?.occurredAt
      )
    : undefined;

  const providerLatency: ServiceReviewLatency = {
    samples: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.length ? Math.max(...latencies) : undefined
  };

  const corrections = failures.map(correctionForFailure);
  if (
    typeof providerLatency.p95Ms === 'number' &&
    providerLatency.p95Ms > 300
  ) {
    corrections.push({
      id: 'correction:provider-latency',
      code: 'review_provider_latency',
      title: 'Review provider response latency',
      reason: `Observed provider-response p95 was ${Math.round(providerLatency.p95Ms)} ms. This is not the full command-to-observed latency gate; measure the complete local path before the next service.`
    });
  }

  return {
    planId: input.plan.id,
    revision: input.plan.revision,
    generatedAt: (input.now || new Date()).toISOString(),
    liveSessionId: input.liveSessionId,
    plannedItems: items.length,
    executedPlannedItems: items.filter(item => item.status === 'executed').length,
    explicitlySkippedItems: items.filter(item => item.status === 'skipped').length,
    notObservedItems: items.filter(item => item.status === 'not-observed').length,
    adHocRunOfShowActions: adHoc.length,
    warningEvents: scopedEvents.filter(event => event.level === 'warning').length,
    errorEvents: scopedEvents.filter(event => event.level === 'error').length,
    plannedDurationSeconds,
    observedRunOfShowDurationSeconds,
    requestSummary: reviewRequests(scopedEvents),
    providerLatency,
    items,
    adHoc,
    failures,
    corrections,
    originCounts,
    eventTypeCounts,
    factsOnly: true
  };
}
