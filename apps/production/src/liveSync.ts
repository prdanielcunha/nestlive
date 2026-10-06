import {
  doc,
  runTransaction
} from 'firebase/firestore';
import type {
  EntitySyncState,
  SyncConflict,
  SyncEntityKind,
  SyncMutation
} from '@millionsnest/nestlive-production-domain';
import { db } from './firebase';
import { liveFeatureFlags } from './featureFlags';
import { SYNC_COLLECTION_BY_ENTITY, LIVE_COLLECTIONS } from './liveCollections';
import {
  IndexedDbSyncStore,
  SyncConflictError,
  SyncEngine,
  SyncTransportError,
  type SyncApplyResult,
  type SyncMutationInput
} from './syncEngine';

interface RemoteSyncMeta {
  version?: string;
  mutationId?: string;
  actorId?: string;
  origin?: string;
  updatedAt?: string;
}

const SECRET_FIELD_NAMES = new Set([
  'token',
  'password',
  'secret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'providertoken',
  'authorization'
]);

function normalizedSecretKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function assertCloudPayloadSafe(
  value: unknown,
  path = 'payload',
  depth = 0
): void {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertCloudPayloadSafe(item, `${path}[${index}]`, depth + 1)
    );
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(normalizedSecretKey(key))) {
      throw new SyncTransportError(
        `sync_payload_contains_secret:${path}.${key}`,
        false
      );
    }
    assertCloudPayloadSafe(child, `${path}.${key}`, depth + 1);
  }
}

function remotePayload(
  data: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!data) return null;
  const { _sync: _ignoredSync, ...payload } = data;
  return payload;
}

class FirestoreLiveSyncTransport {
  async apply(mutation: SyncMutation): Promise<SyncApplyResult> {
    assertCloudPayloadSafe(mutation.payload);
    const collectionName = SYNC_COLLECTION_BY_ENTITY[mutation.entityKind];
    const target = doc(db, collectionName, mutation.entityId);
    const history = doc(db, LIVE_COLLECTIONS.changeHistory, mutation.id);

    try {
      return await runTransaction(db, async transaction => {
        const snapshot = await transaction.get(target);
        const data = snapshot.exists()
          ? snapshot.data() as Record<string, unknown>
          : undefined;
        const syncMeta = data?._sync && typeof data._sync === 'object'
          ? data._sync as RemoteSyncMeta
          : {};
        const remoteVersion = typeof syncMeta.version === 'string'
          ? syncMeta.version
          : null;
        const remoteMutationId = typeof syncMeta.mutationId === 'string'
          ? syncMeta.mutationId
          : null;

        if (
          remoteMutationId === mutation.id ||
          remoteVersion === mutation.version
        ) {
          return {
            version: remoteVersion || mutation.version,
            mutationId: remoteMutationId || mutation.id
          };
        }

        if (
          mutation.conflictPolicy === 'append-only' &&
          snapshot.exists()
        ) {
          throw new SyncConflictError(
            remoteVersion,
            remotePayload(data)
          );
        }

        if (
          mutation.conflictPolicy === 'manual' &&
          mutation.baseVersion &&
          remoteVersion &&
          mutation.baseVersion !== remoteVersion
        ) {
          throw new SyncConflictError(
            remoteVersion,
            remotePayload(data)
          );
        }

        const updatedAt = new Date().toISOString();
        const sync = {
          version: mutation.version,
          mutationId: mutation.id,
          actorId: mutation.actorId,
          origin: mutation.origin,
          updatedAt
        };

        if (mutation.operation === 'delete') {
          transaction.delete(target);
        } else {
          transaction.set(target, {
            ...(mutation.payload || {}),
            _sync: sync
          }, { merge: true });
        }

        transaction.set(history, {
          id: mutation.id,
          organizationId: mutation.organizationId,
          ...(mutation.venueId ? { venueId: mutation.venueId } : {}),
          ...(mutation.liveSystemId ? { liveSystemId: mutation.liveSystemId } : {}),
          entityKind: mutation.entityKind,
          entityId: mutation.entityId,
          operation: mutation.operation,
          payload: mutation.payload || null,
          baseVersion: mutation.baseVersion || null,
          version: mutation.version,
          origin: mutation.origin,
          actorId: mutation.actorId,
          createdAt: mutation.createdAt,
          committedAt: updatedAt
        });

        return {
          version: mutation.version,
          mutationId: mutation.id
        };
      });
    } catch (error: any) {
      if (error instanceof SyncConflictError) throw error;
      const code = String(error?.code || error?.message || 'sync_firestore_failed');
      const retryable = [
        'unavailable',
        'deadline-exceeded',
        'resource-exhausted',
        'aborted',
        'network-request-failed'
      ].some(value => code.includes(value));
      throw new SyncTransportError(code, retryable);
    }
  }
}

const syncStore = new IndexedDbSyncStore();
export const liveSyncEngine = new SyncEngine({
  transport: new FirestoreLiveSyncTransport(),
  store: syncStore,
  enabled: () => liveFeatureFlags.servicePlanWrites
});

let browserHooksInstalled = false;

export async function initializeLiveSync(): Promise<void> {
  await liveSyncEngine.initialize();
  if (browserHooksInstalled || typeof window === 'undefined') return;
  browserHooksInstalled = true;

  window.addEventListener('online', () => {
    void liveSyncEngine.flush();
  });
  window.addEventListener('focus', () => {
    if (navigator.onLine) void liveSyncEngine.flush();
  });
}

export async function queueLiveSync<TPayload extends Record<string, unknown>>(
  input: SyncMutationInput<TPayload>
): Promise<EntitySyncState> {
  await initializeLiveSync();
  return liveSyncEngine.enqueue(input);
}

export async function liveSyncState(
  entityKind: SyncEntityKind,
  entityId: string
): Promise<EntitySyncState | null> {
  await initializeLiveSync();
  return liveSyncEngine.state(entityKind, entityId);
}

export async function liveSyncConflict(
  entityKind: SyncEntityKind,
  entityId: string
): Promise<SyncConflict | null> {
  await initializeLiveSync();
  return liveSyncEngine.conflict(entityKind, entityId);
}
