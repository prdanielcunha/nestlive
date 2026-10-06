import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PeerNodeStore } from '../src/peerNodeStore';

describe('PeerNodeStore', () => {
  it('persists peer credentials locally and restores the record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-peers-'));
    const path = join(dir, 'peers.json');
    const store = new PeerNodeStore(path);

    await store.upsert({
      nodeId: 'node_led',
      baseUrl: 'http://192.168.1.44:4317',
      token: 'secret-peer-token',
      displayName: 'PC LED',
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      pairedAt: '2026-09-19T12:00:00.000Z'
    });

    const restored = new PeerNodeStore(path);
    expect((await restored.get('node_led'))?.displayName).toBe('PC LED');

    const persisted = await readFile(path, 'utf8');
    expect(persisted).toContain('secret-peer-token');
    expect(persisted).toContain('http://192.168.1.44:4317');
  });

  it('upserts and removes one peer without touching the others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-peers-'));
    const store = new PeerNodeStore(join(dir, 'peers.json'));

    const base = {
      baseUrl: 'http://192.168.1.40:4317',
      token: 'token',
      organizationId: 'org_1',
      venueId: 'venue_1',
      liveSystemId: 'system_1',
      pairedAt: '2026-09-19T12:00:00.000Z'
    };

    await store.upsert({ ...base, nodeId: 'node_a', displayName: 'PC A' });
    await store.upsert({
      ...base,
      nodeId: 'node_b',
      baseUrl: 'http://192.168.1.41:4317',
      displayName: 'PC B'
    });
    await store.upsert({
      ...base,
      nodeId: 'node_a',
      displayName: 'PC Projeção'
    });

    expect((await store.get('node_a'))?.displayName).toBe('PC Projeção');
    expect((await store.all()).length).toBe(2);

    expect(await store.remove('node_a')).toBe(true);
    expect(await store.get('node_a')).toBeNull();
    expect(await store.get('node_b')).not.toBeNull();
  });
});
