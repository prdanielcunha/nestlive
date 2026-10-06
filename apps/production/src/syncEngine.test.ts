import { describe, expect, it } from 'vitest';
import {
  MemorySyncStore,
  SyncConflictError,
  SyncEngine,
  syncEntityKey,
  type SyncTransport
} from './syncEngine';

function input() {
  return {
    organizationId: 'org-1',
    venueId: 'venue-1',
    liveSystemId: 'system-1',
    entityKind: 'scene' as const,
    entityId: 'scene-1',
    payload: { id: 'scene-1', name: 'Pregação' },
    origin: 'studio' as const,
    actorId: 'user-1',
    conflictPolicy: 'manual' as const
  };
}

describe('SyncEngine', () => {
  it('reports local instead of offline when cloud writes are intentionally disabled', async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine({
      store,
      enabled: () => false,
      online: () => true,
      transport: {
        async apply(mutation) {
          return { version: mutation.version, mutationId: mutation.id };
        }
      }
    });

    const state = await engine.enqueue(input());
    expect(state.status).toBe('local');
    expect(await store.listMutations()).toHaveLength(1);
  });

  it('keeps a local mutation durable and truthful while offline', async () => {
    const store = new MemorySyncStore();
    let writes = 0;
    const engine = new SyncEngine({
      store,
      enabled: () => true,
      online: () => false,
      transport: {
        async apply() {
          writes += 1;
          return { version: 'v1', mutationId: 'm1' };
        }
      }
    });

    const state = await engine.enqueue(input());
    await engine.flush();

    expect(state.status).toBe('offline');
    expect((await engine.state('scene', 'scene-1'))?.status).toBe('offline');
    expect(writes).toBe(0);
    expect(await store.listMutations()).toHaveLength(1);
  });

  it('replays the outbox once after connectivity returns and records the acknowledged version', async () => {
    const store = new MemorySyncStore();
    let online = false;
    let writes = 0;
    const transport: SyncTransport = {
      async apply(mutation) {
        writes += 1;
        return { version: mutation.version, mutationId: mutation.id };
      }
    };
    const engine = new SyncEngine({
      store,
      enabled: () => true,
      online: () => online,
      transport
    });

    await engine.enqueue(input());
    online = true;
    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);

    const state = await engine.state('scene', 'scene-1');
    expect(state?.status).toBe('synced');
    expect(state?.version).toBeTruthy();
    expect(writes).toBe(1);
    expect(await store.listMutations()).toHaveLength(0);
  });

  it('marks a reproducible manual conflict instead of overwriting remote state', async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine({
      store,
      enabled: () => true,
      online: () => true,
      transport: {
        async apply() {
          throw new SyncConflictError('remote-v2', {
            id: 'scene-1',
            name: 'Remote'
          });
        }
      }
    });

    await engine.enqueue({ ...input(), baseVersion: 'remote-v1' });
    await engine.flush();

    const state = await engine.state('scene', 'scene-1');
    const conflict = await engine.conflict('scene', 'scene-1');
    expect(state?.status).toBe('conflict');
    expect(conflict?.remoteVersion).toBe('remote-v2');
    expect(conflict?.remotePayload).toMatchObject({ name: 'Remote' });
  });

  it('can resolve a conflict by accepting the remote version without another write', async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine({
      store,
      enabled: () => true,
      online: () => true,
      transport: {
        async apply() {
          throw new SyncConflictError('remote-v2', { name: 'Remote' });
        }
      }
    });

    await engine.enqueue({ ...input(), baseVersion: 'remote-v1' });
    await engine.flush();
    await engine.resolveConflict('scene', 'scene-1', 'use-remote');

    expect(await engine.conflict('scene', 'scene-1')).toBeNull();
    expect((await engine.state('scene', 'scene-1'))?.status).toBe('synced');
    expect((await engine.state('scene', 'scene-1'))?.version).toBe('remote-v2');
    expect(await store.listMutations()).toHaveLength(0);
  });

  it('detects a conflicting remote listener update while a local mutation is pending', async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine({
      store,
      enabled: () => false,
      online: () => true,
      transport: {
        async apply(mutation) {
          return { version: mutation.version, mutationId: mutation.id };
        }
      }
    });

    await store.putState({
      key: syncEntityKey('scene', 'scene-1'),
      entityKind: 'scene',
      entityId: 'scene-1',
      status: 'synced',
      version: 'remote-v1',
      updatedAt: '2026-09-24T00:00:00.000Z'
    });

    await engine.enqueue(input());
    await engine.observeRemote({
      entityKind: 'scene',
      entityId: 'scene-1',
      version: 'remote-v2',
      mutationId: 'someone-else',
      payload: { name: 'Changed elsewhere' }
    });

    expect((await engine.state('scene', 'scene-1'))?.status).toBe('conflict');
  });
});
