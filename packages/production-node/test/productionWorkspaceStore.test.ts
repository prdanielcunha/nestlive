import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProductionWorkspaceStore } from '../src/productionWorkspaceStore';

const scope = {
  organizationId: 'org-1',
  venueId: 'venue-1',
  liveSystemId: 'system-1'
};

describe('ProductionWorkspaceStore', () => {
  it('keeps audio profiles inside the paired live-system scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-workspace-'));
    const store = new ProductionWorkspaceStore(join(dir, 'workspace.json'));

    await store.upsertAudioProfile({
      id: 'audio-main',
      ...scope,
      name: 'Domingo principal',
      routes: [{
        id: 'route-vocal',
        name: 'Vocal principal',
        providerId: 'osc-mixer',
        externalRouteId: '/mix/input/1',
        direction: 'input'
      }]
    }, scope);

    expect(await store.audioProfiles(scope)).toHaveLength(1);
    await expect(store.upsertAudioProfile({
      id: 'wrong',
      organizationId: 'org-2',
      venueId: 'venue-1',
      liveSystemId: 'system-1',
      name: 'Cross tenant',
      routes: []
    }, scope)).rejects.toThrow('audio_profile_scope_forbidden');
  });

  it('requires controlled review before a marketplace template can be approved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-workspace-'));
    const store = new ProductionWorkspaceStore(join(dir, 'workspace.json'));

    const draft = await store.upsertTemplate({
      id: 'template-1',
      name: 'Culto padrão',
      kind: 'full-production',
      payload: { sceneIds: ['scene-1'] },
      marketplaceStatus: 'review'
    }, 'org-1', 'owner-1');

    expect(draft.marketplaceStatus).toBe('review');
    const approved = await store.decideMarketplace({
      organizationId: 'org-1',
      templateId: 'template-1',
      decision: 'approved',
      reviewerId: 'reviewer-1'
    });
    expect(approved.marketplaceStatus).toBe('approved');
    expect(approved.shared).toBe(true);
  });
});
