import { describe, expect, it } from 'vitest';
import {
  createLiveNodeBackup,
  validateLiveNodeBackup
} from '../src/nodeBackup';

const scope = {
  organizationId: 'org-1',
  venueId: 'venue-1',
  liveSystemId: 'system-1'
};

describe('Live Node backup', () => {
  function makeBackup() {
    return createLiveNodeBackup({
      appVersion: '0.1.0-beta.2',
      nodeId: 'node-a',
      ...scope,
      servicePlan: {
        id: 'plan-1',
        ...scope,
        title: 'Sunday',
        scheduledAt: '2026-09-27T19:00:00-03:00',
        revision: 2,
        items: []
      },
      providerLinks: [],
      scenes: [],
      routing: {},
      signalTopology: {
        revision: 0,
        updatedAt: '2026-09-26T12:00:00.000Z',
        endpoints: [],
        links: []
      },
      audioProfiles: [],
      templates: [],
      now: new Date('2026-09-26T12:00:00.000Z')
    });
  }

  it('never marks secrets as included and verifies every section checksum', () => {
    const backup = makeBackup();
    expect(backup.manifest.secretsIncluded).toBe(false);
    expect(validateLiveNodeBackup(backup, scope).manifest.backupId)
      .toBe(backup.manifest.backupId);
  });

  it('rejects tampering and cross-tenant restore', () => {
    const backup = makeBackup();
    backup.data.servicePlan!.title = 'tampered';
    expect(() => validateLiveNodeBackup(backup, scope))
      .toThrow('backup_checksum_mismatch:servicePlan');

    const clean = makeBackup();
    expect(() => validateLiveNodeBackup(clean, {
      ...scope,
      organizationId: 'org-2'
    })).toThrow('backup_scope_forbidden');
  });
});
