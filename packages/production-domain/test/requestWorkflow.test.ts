import { describe, expect, it } from 'vitest';
import {
  canTransitionLiveRequest,
  migrateLegacyLiveRequest,
  transitionLiveRequest
} from '../src/requestWorkflow';
import type { LiveRequest } from '../src/types';

function request(status: LiveRequest['status'] = 'sent'): LiveRequest {
  return {
    id: 'request-a',
    organizationId: 'org-a',
    venueId: 'venue-a',
    liveSessionId: 'session-a',
    actorId: 'pastor-a',
    kind: 'bible',
    payload: { reference: 'João 3:16' },
    status,
    createdAt: '2026-09-24T12:00:00.000Z'
  };
}

describe('Live request workflow', () => {
  it('enforces sent → seen → accepted → prepared → executed', () => {
    const seen = transitionLiveRequest(request(), 'seen', 'operator', '2026-09-24T12:00:01.000Z');
    const accepted = transitionLiveRequest(seen, 'accepted', 'operator', '2026-09-24T12:00:02.000Z');
    const prepared = transitionLiveRequest(accepted, 'prepared', 'operator', '2026-09-24T12:00:03.000Z');
    const executed = transitionLiveRequest(prepared, 'executed', 'operator', '2026-09-24T12:00:04.000Z');

    expect(executed.status).toBe('executed');
    expect(executed.seenAt).toBeTruthy();
    expect(executed.acceptedAt).toBeTruthy();
    expect(executed.preparedAt).toBeTruthy();
    expect(executed.executedAt).toBeTruthy();
    expect(executed.resolvedAt).toBeTruthy();
  });

  it('allows fast accept but never accepts execution before preparation', () => {
    expect(canTransitionLiveRequest('sent', 'accepted')).toBe(true);
    expect(canTransitionLiveRequest('accepted', 'executed')).toBe(false);
    expect(() => transitionLiveRequest(request('accepted'), 'executed', 'operator'))
      .toThrow('invalid_live_request_transition');
  });

  it('treats rejection as terminal', () => {
    const rejected = transitionLiveRequest(request(), 'rejected', 'operator');
    expect(() => transitionLiveRequest(rejected, 'accepted', 'operator'))
      .toThrow('invalid_live_request_transition');
  });

  it('migrates legacy pending/completed records without changing payload', () => {
    const pending = migrateLegacyLiveRequest({ ...request(), status: 'pending' as never });
    const completed = migrateLegacyLiveRequest({ ...request(), status: 'completed' as never });
    expect(pending.status).toBe('sent');
    expect(completed.status).toBe('executed');
    expect(pending.payload.reference).toBe('João 3:16');
  });
});
