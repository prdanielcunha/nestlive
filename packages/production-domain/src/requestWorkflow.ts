import type { LiveRequest, LiveRequestStatus } from './types';

const ALLOWED: Record<LiveRequestStatus, ReadonlySet<LiveRequestStatus>> = {
  sent: new Set(['seen', 'accepted', 'rejected']),
  seen: new Set(['accepted', 'rejected']),
  accepted: new Set(['prepared', 'rejected']),
  prepared: new Set(['executed', 'rejected']),
  executed: new Set(),
  rejected: new Set()
};

export function normalizeLiveRequestStatus(value: unknown): LiveRequestStatus {
  if (value === 'pending') return 'sent';
  if (value === 'completed') return 'executed';
  if (
    value === 'sent' ||
    value === 'seen' ||
    value === 'accepted' ||
    value === 'prepared' ||
    value === 'executed' ||
    value === 'rejected'
  ) return value;
  return 'sent';
}

export function canTransitionLiveRequest(
  from: LiveRequestStatus,
  to: LiveRequestStatus
): boolean {
  return from === to || ALLOWED[from].has(to);
}

export function transitionLiveRequest(
  request: LiveRequest,
  to: LiveRequestStatus,
  actorId: string,
  occurredAt = new Date().toISOString()
): LiveRequest {
  const from = normalizeLiveRequestStatus(request.status);
  if (!canTransitionLiveRequest(from, to)) {
    throw new Error(`invalid_live_request_transition:${from}->${to}`);
  }
  if (from === to) return { ...request, status: from };

  const base: LiveRequest = {
    ...request,
    status: to,
    updatedAt: occurredAt,
    resolvedBy: actorId
  };

  if (to === 'seen') return { ...base, seenAt: request.seenAt || occurredAt };
  if (to === 'accepted') return {
    ...base,
    seenAt: request.seenAt || occurredAt,
    acceptedAt: request.acceptedAt || occurredAt
  };
  if (to === 'prepared') return {
    ...base,
    seenAt: request.seenAt || occurredAt,
    acceptedAt: request.acceptedAt || occurredAt,
    preparedAt: request.preparedAt || occurredAt
  };
  if (to === 'executed') return {
    ...base,
    executedAt: request.executedAt || occurredAt,
    resolvedAt: request.resolvedAt || occurredAt
  };
  return {
    ...base,
    rejectedAt: request.rejectedAt || occurredAt,
    resolvedAt: request.resolvedAt || occurredAt
  };
}

export function migrateLegacyLiveRequest(request: LiveRequest): LiveRequest {
  const status = normalizeLiveRequestStatus((request as LiveRequest & { status: unknown }).status);
  if (status === request.status) return request;
  return { ...request, status };
}
