import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScaleAudioContextStore } from '../src';

const binding = {
  nodeId: 'node-1',
  organizationId: 'org-1',
  venueId: 'monte',
  liveSystemId: 'live-1',
  deviceId: 'device-1',
  deviceName: 'iPad',
  pairedAt: '2026-10-05T00:00:00Z',
  lastSeenAt: '2026-10-05T00:00:00Z'
};

describe('ScaleAudioContextStore', () => {
  it('keeps scale people contextual and channel mappings venue-local', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-scale-audio-'));
    try {
      const store = new ScaleAudioContextStore(
        path.join(dir, 'scale-audio.json')
      );
      await store.saveContext(binding, {
        serviceId: 'scale-1',
        organizationId: 'org-1',
        liveSystemId: 'live-1',
        title: 'Culto',
        scheduledAt: '2026-10-05T19:00:00-03:00',
        participants: [
          { userId: 'u-1', displayName: 'Ana', roleName: 'Vocal' }
        ]
      });
      await store.upsertAssignment({
        participantUserId: 'u-1',
        roleName: 'Vocal',
        channelId: 'ch-03'
      });

      const current = await store.current();
      expect(current?.venueId).toBe('monte');
      expect(current?.assignments[0]).toMatchObject({
        participantUserId: 'u-1',
        channelId: 'ch-03'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects context from another token scope', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-scale-scope-'));
    try {
      const store = new ScaleAudioContextStore(
        path.join(dir, 'scale-audio.json')
      );
      await expect(
        store.saveContext(binding, {
          serviceId: 'scale-2',
          organizationId: 'other-org',
          title: 'Outro',
          scheduledAt: '2026-10-05T20:00:00-03:00',
          participants: []
        })
      ).rejects.toThrow('scale_audio_scope_mismatch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
