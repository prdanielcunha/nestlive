import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveChatMessage } from '@millionsnest/nestlive-production-domain';
import { LiveChatStore } from '../src/liveChatStore';

function message(
  id: string,
  createdAt: string,
  overrides: Partial<LiveChatMessage> = {}
): LiveChatMessage {
  return {
    id,
    organizationId: 'org_1',
    venueId: 'venue_1',
    liveSystemId: 'system_1',
    liveSessionId: 'session_1',
    actorId: 'actor_1',
    senderContext: 'operator',
    audience: 'team',
    text: `Message ${id}`,
    createdAt,
    ...overrides
  };
}

describe('LiveChatStore', () => {
  it('persists scoped session chat in chronological order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-chat-'));
    const path = join(dir, 'chat.json');
    const store = new LiveChatStore(path);

    await store.append(message('m2', '2026-09-22T10:00:02.000Z'));
    await store.append(message('m1', '2026-09-22T10:00:01.000Z'));
    await store.append(message('other', '2026-09-22T10:00:03.000Z', {
      liveSessionId: 'session_2'
    }));

    const restored = new LiveChatStore(path);
    const results = await restored.list({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1',
      limit: 20
    });

    expect(results.map(item => item.id)).toEqual(['m1', 'm2']);
  });

  it('deduplicates message IDs and bounds retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-chat-'));
    const path = join(dir, 'chat.json');
    const store = new LiveChatStore(path, 3);

    await store.append(message('m1', '2026-09-22T10:00:01.000Z'));
    await store.append(message('m1', '2026-09-22T10:00:01.000Z'));
    await store.append(message('m2', '2026-09-22T10:00:02.000Z'));
    await store.append(message('m3', '2026-09-22T10:00:03.000Z'));
    await store.append(message('m4', '2026-09-22T10:00:04.000Z'));

    const results = await store.list({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1',
      limit: 20
    });

    expect(results.map(item => item.id)).toEqual(['m2', 'm3', 'm4']);
  });

  it('returns only the requested venue and live system scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-chat-'));
    const store = new LiveChatStore(join(dir, 'chat.json'));

    await store.append(message('visible', '2026-09-22T10:00:01.000Z'));
    await store.append(message('other-venue', '2026-09-22T10:00:02.000Z', {
      venueId: 'venue_2'
    }));
    await store.append(message('other-system', '2026-09-22T10:00:03.000Z', {
      liveSystemId: 'system_2'
    }));

    const results = await store.list({
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      liveSessionId: 'session_1'
    });

    expect(results.map(item => item.id)).toEqual(['visible']);
  });
});
