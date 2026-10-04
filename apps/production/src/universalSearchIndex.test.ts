import { describe, expect, it } from 'vitest';
import { UniversalSearchIndex } from './universalSearchIndex';
import type { ProviderLink, ServicePlan } from '@millionsnest/nestlive-production-domain';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    }
  };
}

const plan: ServicePlan = {
  id: 'plan-a',
  organizationId: 'org-a',
  venueId: 'venue-a',
  liveSystemId: 'system-a',
  title: 'Sunday',
  scheduledAt: '2026-09-27T19:00:00-03:00',
  revision: 1,
  items: [{
    id: 'song:a',
    type: 'song',
    title: 'Tu És Fiel Senhor',
    providerLinkId: 'link-a',
    state: 'prepared',
    payload: { artist: 'Equipe', key: 'G' }
  }]
};

const links: ProviderLink[] = [{
  id: 'link-a',
  organizationId: 'org-a',
  venueId: 'venue-a',
  providerInstanceId: 'holyrics-primary',
  entityType: 'song',
  externalId: 'song-external-a'
}];

describe('UniversalSearchIndex', () => {
  it('finds prepared content locally with typo tolerance', () => {
    const index = new UniversalSearchIndex('test', memoryStorage());
    index.seedPrepared(plan, links, [], []);

    const hit = index.search('tu es fiel senho')[0];
    expect(hit?.kind).toBe('song');
    expect(hit?.payload).toEqual({ id: 'song-external-a' });
    expect(hit?.targetProviderIds).toEqual(['holyrics-primary']);
  });

  it('prioritizes prepared content and never executes during search', () => {
    const index = new UniversalSearchIndex('test', memoryStorage());
    index.seedPrepared(plan, links, [], []);
    const results = index.search('fiel');

    expect(results[0]?.source).toBe('prepared-plan');
    expect(results[0]).not.toHaveProperty('execute');
  });

  it('indexes deterministic commands as preparable documents', () => {
    const index = new UniversalSearchIndex('test', memoryStorage());
    const hit = index.search('limpar')[0];

    expect(hit?.kind).toBe('command');
    expect(hit?.capability).toBe('presentation.clear');
    expect(hit?.payload).toEqual({});
  });

  it('boosts recent frequently used aliases without network access', () => {
    const storage = memoryStorage();
    const index = new UniversalSearchIndex('test', storage);
    index.remember({
      id: 'recent-song',
      kind: 'song',
      title: 'Bondade de Deus',
      aliases: ['bondade'],
      capability: 'songs.present',
      payload: { id: 'recent-external' },
      targetProviderIds: ['holyrics-primary'],
      source: 'recent'
    });
    index.remember({
      id: 'recent-song',
      kind: 'song',
      title: 'Bondade de Deus',
      aliases: ['bondade'],
      capability: 'songs.present',
      payload: { id: 'recent-external' },
      targetProviderIds: ['holyrics-primary'],
      source: 'recent'
    });

    const restarted = new UniversalSearchIndex('test', storage);
    const hit = restarted.search('bondade')[0];
    expect(hit?.id).toBe('recent-song');
    expect(hit?.useCount).toBeGreaterThanOrEqual(2);
  });
});
