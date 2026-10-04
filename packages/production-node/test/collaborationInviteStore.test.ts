import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollaborationInviteStore } from '../src/collaborationInviteStore';

const binding = {
  nodeId: 'node_1',
  organizationId: 'org_1',
  venueId: 'venue_1',
  liveSystemId: 'system_1',
  deviceId: 'operator',
  deviceName: 'Production',
  pairedAt: '2026-09-24T12:00:00.000Z',
  lastSeenAt: '2026-09-24T12:00:00.000Z'
};

describe('CollaborationInviteStore', () => {
  it('persists only hashes and issues an expiring least-privilege pastor grant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-collab-'));
    const path = join(dir, 'collaboration.json');
    const store = new CollaborationInviteStore(path, 'node_1');
    const created = await store.createInvite({
      binding,
      liveSessionId: 'session_1',
      role: 'pastor',
      createdBy: 'operator'
    });
    const redeemed = await store.redeem({
      inviteId: created.invite.id,
      secret: created.secret,
      actorId: 'pastor_device',
      deviceId: 'iphone_1',
      deviceName: 'Pastor iPhone'
    });

    expect(redeemed.grant.role).toBe('pastor');
    expect(redeemed.grant.permissions).toContain('request.bible');
    expect(redeemed.grant.permissions).not.toContain('request.section');
    expect((await store.authorize(redeemed.token))?.grant.liveSessionId).toBe('session_1');

    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain(created.secret);
    expect(persisted).not.toContain(redeemed.token);
  });

  it('enforces role permissions and max uses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-collab-'));
    const store = new CollaborationInviteStore(join(dir, 'collaboration.json'), 'node_1');
    const created = await store.createInvite({
      binding,
      liveSessionId: 'session_2',
      role: 'conductor',
      createdBy: 'operator',
      maxUses: 1
    });
    const first = await store.redeem({
      inviteId: created.invite.id,
      secret: created.secret,
      actorId: 'conductor_1',
      deviceId: 'phone_1',
      deviceName: 'Phone'
    });
    expect(first.grant.permissions).toContain('request.section');
    expect(first.grant.permissions).not.toContain('request.bible');

    await expect(store.redeem({
      inviteId: created.invite.id,
      secret: created.secret,
      actorId: 'conductor_2',
      deviceId: 'phone_2',
      deviceName: 'Phone 2'
    })).rejects.toThrow('collaboration_invite_exhausted');
  });

  it('revokes every invite and grant for a finished live session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-collab-'));
    const store = new CollaborationInviteStore(join(dir, 'collaboration.json'), 'node_1');
    const created = await store.createInvite({
      binding,
      liveSessionId: 'session_3',
      role: 'viewer',
      createdBy: 'operator'
    });
    const redeemed = await store.redeem({
      inviteId: created.invite.id,
      secret: created.secret,
      actorId: 'viewer_1',
      deviceId: 'phone_3',
      deviceName: 'Phone 3'
    });

    expect(await store.revokeSession('session_3')).toBe(1);
    expect(await store.authorize(redeemed.token)).toBeNull();
    expect(await store.listActive('session_3')).toEqual([]);
  });
});
