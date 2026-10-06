import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveSessionEvent } from '@millionsnest/nestlive-production-domain';
import { LiveEventLogStore } from '../src/liveEventLogStore';

function event(
  id: string,
  occurredAt: string,
  overrides: Partial<LiveSessionEvent> = {}
): LiveSessionEvent {
  return {
    id,
    correlationId: id,
    type: 'command.completed',
    occurredAt,
    source: 'live-node',
    organizationId: 'org_1',
    venueId: 'venue_1',
    liveSystemId: 'system_1',
    liveSessionId: 'session_1',
    actorId: 'actor_1',
    level: 'info',
    payload: {},
    ...overrides
  };
}

describe('LiveEventLogStore', () => {
  it('persists scoped events and returns newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-events-'));
    const path = join(dir, 'events.json');
    const store = new LiveEventLogStore(path);

    await store.append(event('e1', '2026-09-21T10:00:00.000Z'));
    await store.append(event('e2', '2026-09-21T10:00:02.000Z'));
    await store.append(event('e3', '2026-09-21T10:00:01.000Z', {
      liveSessionId: 'session_2'
    }));

    const restored = new LiveEventLogStore(path);
    const results = await restored.list({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1',
      limit: 10
    });

    expect(results.map(item => item.id)).toEqual(['e2', 'e1']);
    const query = {
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1'
    };
    expect(await restored.count(query)).toBe(2);
    expect(await restored.summarize(query)).toMatchObject({
      total: 2,
      info: 2,
      warnings: 0,
      errors: 0,
      plannedServiceItems: 0,
      adHocActions: 0
    });
  });

  it('calculates provider acceptance and p95 latency from command events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-events-'));
    const path = join(dir, 'events.json');
    const store = new LiveEventLogStore(path);

    for (let index = 1; index <= 20; index += 1) {
      await store.append(event(
        `command-${index}`,
        `2026-09-21T10:00:${String(index).padStart(2, '0')}.000Z`,
        {
          payload: {
            providers: [{
              providerId: 'holyrics-primary',
              accepted: index !== 20,
              latencyMs: index * 10
            }]
          }
        }
      ));
    }

    const summary = await store.summarize({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1'
    });

    expect(summary.providerCommandResults).toBe(20);
    expect(summary.providerCommandAccepted).toBe(19);
    expect(summary.providerCommandRejected).toBe(1);
    expect(summary.providerLatencySamples).toBe(20);
    expect(summary.providerLatencyP50Ms).toBe(100);
    expect(summary.providerLatencyP95Ms).toBe(190);
    expect(summary.providerLatencyMaxMs).toBe(200);
  });

  it('deduplicates IDs and bounds local retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-events-'));
    const path = join(dir, 'events.json');
    const store = new LiveEventLogStore(path, 3);

    await store.append(event('e1', '2026-09-21T10:00:01.000Z'));
    await store.append(event('e1', '2026-09-21T10:00:01.000Z'));
    await store.append(event('e2', '2026-09-21T10:00:02.000Z'));
    await store.append(event('e3', '2026-09-21T10:00:03.000Z'));
    await store.append(event('e4', '2026-09-21T10:00:04.000Z'));

    const results = await store.list({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      limit: 10
    });

    expect(results.map(item => item.id)).toEqual(['e4', 'e3', 'e2']);
  });
});
