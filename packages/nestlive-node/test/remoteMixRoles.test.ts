import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteMixAuthority } from '../src';

describe('RemoteMixAuthority role permissions', () => {
  it('fails closed when a viewer asks for write access', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-remote-role-'));
    try {
      const authority = new RemoteMixAuthority(
        path.join(dir, 'grants.json')
      );
      await expect(
        authority.issue({
          organizationId: 'org',
          venueId: 'venue',
          liveSystemId: 'live',
          actorId: 'viewer',
          role: 'viewer',
          permissions: ['audio.read', 'audio.fader.write']
        })
      ).rejects.toThrow('remote_grant_permission_not_allowed_for_role');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists active grants without exposing bearer tokens', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-remote-list-'));
    try {
      const authority = new RemoteMixAuthority(
        path.join(dir, 'grants.json')
      );
      const issued = await authority.issue({
        organizationId: 'org',
        venueId: 'venue',
        liveSystemId: 'live',
        actorId: 'tech',
        role: 'technical_admin',
        permissions: ['audio.read', 'audio.critical.write']
      });
      const grants = await authority.list();
      expect(grants).toHaveLength(1);
      expect(JSON.stringify(grants)).not.toContain(issued.token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
