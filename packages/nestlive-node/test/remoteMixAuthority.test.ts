import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RemoteMixAuthority
} from '../src';

describe('RemoteMixAuthority', () => {
  it('issues expiring grants without persisting plaintext tokens', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-remote-'));
    const file = path.join(dir, 'grants.json');

    try {
      const authority = new RemoteMixAuthority(file);
      const issued = await authority.issue(
        {
          organizationId: 'org',
          venueId: 'venue',
          liveSystemId: 'live',
          actorId: 'tech',
          role: 'technical_admin',
          permissions: ['audio.read', 'audio.fader.write'],
          ttlMinutes: 15
        },
        new Date('2026-10-04T15:00:00Z')
      );

      const stored = await readFile(file, 'utf8');
      expect(stored).not.toContain(issued.token);

      const grant = await authority.authenticate(
        issued.token,
        new Date('2026-10-04T15:10:00Z')
      );
      expect(grant?.permissions).toContain('audio.fader.write');

      expect(
        await authority.authenticate(
          issued.token,
          new Date('2026-10-04T15:16:00Z')
        )
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('revokes access immediately', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-revoke-'));
    const file = path.join(dir, 'grants.json');

    try {
      const authority = new RemoteMixAuthority(file);
      const issued = await authority.issue({
        organizationId: 'org',
        venueId: 'venue',
        liveSystemId: 'live',
        actorId: 'operator',
        role: 'operator',
        permissions: ['audio.read']
      });

      expect(await authority.authenticate(issued.token)).toBeDefined();
      expect(await authority.revoke(issued.grant.id)).toBe(true);
      expect(await authority.authenticate(issued.token)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
