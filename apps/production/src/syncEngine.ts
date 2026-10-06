import type {
  EntitySyncState,
  SyncConflict,
  SyncConflictPolicy,
  SyncEntityKind,
  SyncMutation,
  SyncStatus
} from '@millionsnest/nestlive-production-domain';

export interface SyncMutationInput<TPayload = Record<string, unknown>> {
  organizationId: string;
  venueId?: string;
  liveSystemId?: string;
  entityKind: SyncEntityKind;
  entityId: string;
  operation?: SyncMutation['operation'];
  payload?: TPayload;
  baseVersion?: string | null;
  origin: SyncMutation['origin'];
  actorId: string;
  conflictPolicy?: SyncConflictPolicy;
}

export interface SyncApplyResult {
  version: string;
  mutationId: string;
}

export interface SyncTransport {
  apply(mutation: SyncMutation): Promise<SyncApplyResult>;
}

export interface SyncHistoryEntry {
  id: string;
  mutationId: string;
  entityKey: string;
  status: SyncStatus;
  at: string;
  errorCode?: string;
}

export interface SyncStore {
  listMutations(): Promise<SyncMutation[]>;
  putMutation(mutation: SyncMutation): Promise<void>;
  deleteMutation(id: string): Promise<void>;
  getState(key: string): Promise<EntitySyncState | null>;
  listStates(): Promise<EntitySyncState[]>;
  putState(state: EntitySyncState): Promise<void>;
  getConflict(key: string): Promise<SyncConflict | null>;
  putConflict(key: string, conflict: SyncConflict): Promise<void>;
  deleteConflict(key: string): Promise<void>;
  appendHistory(entry: SyncHistoryEntry): Promise<void>;
  listHistory(limit?: number): Promise<SyncHistoryEntry[]>;
}

export class SyncConflictError extends Error {
  constructor(
    readonly remoteVersion: string | null,
    readonly remotePayload: Record<string, unknown> | null
  ) {
    super('sync_conflict');
  }
}

export class SyncTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true
  ) {
    super(code);
  }
}

export function syncEntityKey(
  entityKind: SyncEntityKind,
  entityId: string
): string {
  return `${entityKind}:${entityId}`;
}

function iso(now: () => number): string {
  return new Date(now()).toISOString();
}

function defaultId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function retryDelayMs(attempt: number, jitter: number): number {
  const exponential = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return Math.round(exponential * (0.8 + Math.max(0, Math.min(1, jitter)) * 0.4));
}

function errorCode(error: unknown): string {
  if (error instanceof SyncTransportError) return error.code;
  if (error instanceof SyncConflictError) return 'sync_conflict';
  if (error instanceof Error && error.message) return error.message;
  return 'sync_failed';
}

function isRetryable(error: unknown): boolean {
  if (error instanceof SyncTransportError) return error.retryable;
  const code = errorCode(error);
  return [
    'unavailable',
    'deadline-exceeded',
    'resource-exhausted',
    'aborted',
    'network-request-failed',
    'sync_offline'
  ].some(part => code.includes(part));
}

export class MemorySyncStore implements SyncStore {
  private mutations = new Map<string, SyncMutation>();
  private states = new Map<string, EntitySyncState>();
  private conflicts = new Map<string, SyncConflict>();
  private history: SyncHistoryEntry[] = [];

  async listMutations(): Promise<SyncMutation[]> {
    return [...this.mutations.values()].map(item => structuredClone(item));
  }

  async putMutation(mutation: SyncMutation): Promise<void> {
    this.mutations.set(mutation.id, structuredClone(mutation));
  }

  async deleteMutation(id: string): Promise<void> {
    this.mutations.delete(id);
  }

  async getState(key: string): Promise<EntitySyncState | null> {
    const value = this.states.get(key);
    return value ? structuredClone(value) : null;
  }

  async listStates(): Promise<EntitySyncState[]> {
    return [...this.states.values()].map(item => structuredClone(item));
  }

  async putState(state: EntitySyncState): Promise<void> {
    this.states.set(state.key, structuredClone(state));
  }

  async getConflict(key: string): Promise<SyncConflict | null> {
    const value = this.conflicts.get(key);
    return value ? structuredClone(value) : null;
  }

  async putConflict(key: string, conflict: SyncConflict): Promise<void> {
    this.conflicts.set(key, structuredClone(conflict));
  }

  async deleteConflict(key: string): Promise<void> {
    this.conflicts.delete(key);
  }

  async appendHistory(entry: SyncHistoryEntry): Promise<void> {
    this.history.push(structuredClone(entry));
    if (this.history.length > 1000) this.history = this.history.slice(-1000);
  }

  async listHistory(limit = 100): Promise<SyncHistoryEntry[]> {
    return this.history.slice(-limit).reverse().map(item => structuredClone(item));
  }
}

type SyncDbStoreName = 'outbox' | 'states' | 'conflicts' | 'history';

interface ConflictRecord {
  key: string;
  conflict: SyncConflict;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
  });
}

export class IndexedDbSyncStore implements SyncStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly databaseName = 'nestlive-sync-v1'
  ) {}

  private db(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('indexeddb_unavailable'));
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('states')) {
          db.createObjectStore('states', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('conflicts')) {
          db.createObjectStore('conflicts', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
    });

    return this.dbPromise;
  }

  private async readAll<T>(storeName: SyncDbStoreName): Promise<T[]> {
    const db = await this.db();
    const tx = db.transaction(storeName, 'readonly');
    return requestResult(tx.objectStore(storeName).getAll()) as Promise<T[]>;
  }

  private async get<T>(storeName: SyncDbStoreName, key: IDBValidKey): Promise<T | null> {
    const db = await this.db();
    const tx = db.transaction(storeName, 'readonly');
    const result = await requestResult(tx.objectStore(storeName).get(key));
    return (result as T | undefined) || null;
  }

  private async put(storeName: SyncDbStoreName, value: unknown): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(storeName, 'readwrite');
    await requestResult(tx.objectStore(storeName).put(value));
  }

  private async delete(storeName: SyncDbStoreName, key: IDBValidKey): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(storeName, 'readwrite');
    await requestResult(tx.objectStore(storeName).delete(key));
  }

  async listMutations(): Promise<SyncMutation[]> {
    return this.readAll<SyncMutation>('outbox');
  }

  async putMutation(mutation: SyncMutation): Promise<void> {
    await this.put('outbox', mutation);
  }

  async deleteMutation(id: string): Promise<void> {
    await this.delete('outbox', id);
  }

  async getState(key: string): Promise<EntitySyncState | null> {
    return this.get<EntitySyncState>('states', key);
  }

  async listStates(): Promise<EntitySyncState[]> {
    return this.readAll<EntitySyncState>('states');
  }

  async putState(state: EntitySyncState): Promise<void> {
    await this.put('states', state);
  }

  async getConflict(key: string): Promise<SyncConflict | null> {
    const record = await this.get<ConflictRecord>('conflicts', key);
    return record?.conflict || null;
  }

  async putConflict(key: string, conflict: SyncConflict): Promise<void> {
    await this.put('conflicts', { key, conflict } satisfies ConflictRecord);
  }

  async deleteConflict(key: string): Promise<void> {
    await this.delete('conflicts', key);
  }

  async appendHistory(entry: SyncHistoryEntry): Promise<void> {
    await this.put('history', entry);
    const all = await this.readAll<SyncHistoryEntry>('history');
    if (all.length <= 1000) return;
    const sorted = all.sort((a, b) => a.at.localeCompare(b.at));
    for (const stale of sorted.slice(0, all.length - 1000)) {
      await this.delete('history', stale.id);
    }
  }

  async listHistory(limit = 100): Promise<SyncHistoryEntry[]> {
    const all = await this.readAll<SyncHistoryEntry>('history');
    return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }
}

export interface SyncEngineOptions {
  transport: SyncTransport;
  store: SyncStore;
  enabled: () => boolean;
  online?: () => boolean;
  now?: () => number;
  idFactory?: () => string;
  random?: () => number;
  maxAttempts?: number;
}

export class SyncEngine {
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly random: () => number;
  private readonly online: () => boolean;
  private readonly maxAttempts: number;
  private flushPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || defaultId;
    this.random = options.random || Math.random;
    this.online = options.online || (() =>
      typeof navigator === 'undefined' ? true : navigator.onLine
    );
    this.maxAttempts = options.maxAttempts || 8;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const pending = await this.options.store.listMutations();
    if (!this.online()) {
      for (const mutation of pending) {
        await this.setState(mutation, 'offline');
      }
    }

    this.initialized = true;

    if (this.options.enabled() && this.online() && pending.length) {
      void this.flush();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async state(entityKind: SyncEntityKind, entityId: string): Promise<EntitySyncState | null> {
    return this.options.store.getState(syncEntityKey(entityKind, entityId));
  }

  async states(): Promise<EntitySyncState[]> {
    return this.options.store.listStates();
  }

  async history(limit = 100): Promise<SyncHistoryEntry[]> {
    return this.options.store.listHistory(limit);
  }

  async conflict(entityKind: SyncEntityKind, entityId: string): Promise<SyncConflict | null> {
    return this.options.store.getConflict(syncEntityKey(entityKind, entityId));
  }

  async enqueue<TPayload extends Record<string, unknown>>(
    input: SyncMutationInput<TPayload>
  ): Promise<EntitySyncState> {
    await this.initialize();
    const key = syncEntityKey(input.entityKind, input.entityId);
    const previous = await this.options.store.getState(key);
    const id = this.idFactory();
    const createdAt = iso(this.now);
    const mutation: SyncMutation = {
      id,
      organizationId: input.organizationId,
      ...(input.venueId ? { venueId: input.venueId } : {}),
      ...(input.liveSystemId ? { liveSystemId: input.liveSystemId } : {}),
      entityKind: input.entityKind,
      entityId: input.entityId,
      operation: input.operation || 'upsert',
      ...(input.payload ? { payload: structuredClone(input.payload) } : {}),
      baseVersion: input.baseVersion !== undefined
        ? input.baseVersion
        : previous?.version || null,
      version: `${createdAt}:${id}`,
      origin: input.origin,
      actorId: input.actorId,
      createdAt,
      attempt: 0,
      conflictPolicy: input.conflictPolicy || 'manual'
    };

    await this.options.store.putMutation(mutation);
    await this.options.store.deleteConflict(key);
    const enabled = this.options.enabled();
    const state = await this.setState(
      mutation,
      !enabled ? 'local' : this.online() ? 'pending' : 'offline'
    );

    if (this.online() && enabled) void this.flush();
    return state;
  }

  async observeRemote(input: {
    entityKind: SyncEntityKind;
    entityId: string;
    version?: string | null;
    mutationId?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.initialize();
    const key = syncEntityKey(input.entityKind, input.entityId);
    const state = await this.options.store.getState(key);
    const outbox = await this.options.store.listMutations();
    const pending = outbox.find(item =>
      item.entityKind === input.entityKind &&
      item.entityId === input.entityId
    );

    if (pending) {
      if (input.mutationId === pending.id || input.version === pending.version) {
        await this.options.store.deleteMutation(pending.id);
        await this.options.store.deleteConflict(key);
        await this.setState(pending, 'synced', undefined, input.version || pending.version);
        return;
      }

      if (
        pending.conflictPolicy === 'manual' &&
        input.version &&
        pending.baseVersion &&
        input.version !== pending.baseVersion
      ) {
        await this.options.store.putConflict(key, {
          mutation: pending,
          remoteVersion: input.version,
          remotePayload: input.payload || null,
          detectedAt: iso(this.now)
        });
        await this.setState(pending, 'conflict', 'sync_conflict', input.version);
        return;
      }
    }

    if (input.version && (!state || state.status !== 'pending')) {
      await this.options.store.putState({
        key,
        entityKind: input.entityKind,
        entityId: input.entityId,
        status: 'synced',
        version: input.version,
        updatedAt: iso(this.now)
      });
      this.emit();
    }
  }

  async retry(
    entityKind: SyncEntityKind,
    entityId: string
  ): Promise<void> {
    await this.initialize();
    const mutation = (await this.options.store.listMutations()).find(item =>
      item.entityKind === entityKind && item.entityId === entityId
    );
    if (!mutation) return;

    const reset: SyncMutation = {
      ...mutation,
      attempt: 0,
      nextAttemptAt: undefined
    };
    await this.options.store.putMutation(reset);
    await this.setState(
      reset,
      !this.options.enabled()
        ? 'local'
        : this.online()
          ? 'pending'
          : 'offline'
    );
    if (this.options.enabled() && this.online()) {
      await this.flush();
    }
  }

  async resolveConflict(
    entityKind: SyncEntityKind,
    entityId: string,
    resolution: 'keep-local' | 'use-remote'
  ): Promise<void> {
    await this.initialize();
    const key = syncEntityKey(entityKind, entityId);
    const conflict = await this.options.store.getConflict(key);
    if (!conflict) return;

    if (resolution === 'use-remote') {
      await this.options.store.deleteMutation(conflict.mutation.id);
      await this.options.store.deleteConflict(key);
      await this.options.store.putState({
        key,
        entityKind,
        entityId,
        status: 'synced',
        ...(conflict.remoteVersion ? { version: conflict.remoteVersion } : {}),
        updatedAt: iso(this.now)
      });
      this.emit();
      return;
    }

    await this.options.store.deleteMutation(conflict.mutation.id);
    await this.options.store.deleteConflict(key);
    await this.enqueue({
      organizationId: conflict.mutation.organizationId,
      venueId: conflict.mutation.venueId,
      liveSystemId: conflict.mutation.liveSystemId,
      entityKind,
      entityId,
      operation: conflict.mutation.operation,
      payload: conflict.mutation.payload || {},
      baseVersion: conflict.remoteVersion || null,
      origin: conflict.mutation.origin,
      actorId: conflict.mutation.actorId,
      conflictPolicy: conflict.mutation.conflictPolicy
    });
  }

  async flush(): Promise<void> {
    await this.initialize();
    if (!this.options.enabled()) return;
    if (this.flushPromise) return this.flushPromise;

    this.flushPromise = this.flushInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushInternal(): Promise<void> {
    const mutations = (await this.options.store.listMutations())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (!this.online()) {
      for (const mutation of mutations) {
        await this.setState(mutation, 'offline', 'sync_offline');
      }
      return;
    }

    for (const mutation of mutations) {
      if (
        mutation.nextAttemptAt &&
        Date.parse(mutation.nextAttemptAt) > this.now()
      ) {
        continue;
      }

      await this.setState(mutation, 'pending');

      try {
        const result = await this.options.transport.apply(mutation);
        await this.options.store.deleteMutation(mutation.id);
        await this.options.store.deleteConflict(
          syncEntityKey(mutation.entityKind, mutation.entityId)
        );
        await this.setState(mutation, 'synced', undefined, result.version);
      } catch (error) {
        if (error instanceof SyncConflictError) {
          const key = syncEntityKey(mutation.entityKind, mutation.entityId);
          await this.options.store.putConflict(key, {
            mutation,
            remoteVersion: error.remoteVersion,
            remotePayload: error.remotePayload,
            detectedAt: iso(this.now)
          });
          await this.setState(
            mutation,
            'conflict',
            'sync_conflict',
            error.remoteVersion || undefined
          );
          continue;
        }

        const attempt = mutation.attempt + 1;
        const retryable = isRetryable(error);
        if (!retryable || attempt >= this.maxAttempts) {
          await this.options.store.putMutation({ ...mutation, attempt });
          await this.setState(mutation, 'failed', errorCode(error));
          continue;
        }

        const nextAttemptAt = new Date(
          this.now() + retryDelayMs(attempt, this.random())
        ).toISOString();
        await this.options.store.putMutation({
          ...mutation,
          attempt,
          nextAttemptAt
        });
        await this.setState(
          mutation,
          this.online() ? 'pending' : 'offline',
          errorCode(error)
        );
      }
    }

    await this.scheduleNextRetry();
  }

  private async scheduleNextRetry(): Promise<void> {
    if (
      typeof window === 'undefined' ||
      !this.options.enabled() ||
      !this.online()
    ) {
      return;
    }

    const pending = await this.options.store.listMutations();
    const dueTimes = pending
      .map(item => item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : this.now())
      .filter(value => Number.isFinite(value));
    if (!dueTimes.length) return;

    const delay = Math.max(50, Math.min(...dueTimes) - this.now());
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private async setState(
    mutation: SyncMutation,
    status: SyncStatus,
    stateErrorCode?: string,
    version?: string
  ): Promise<EntitySyncState> {
    const state: EntitySyncState = {
      key: syncEntityKey(mutation.entityKind, mutation.entityId),
      entityKind: mutation.entityKind,
      entityId: mutation.entityId,
      status,
      mutationId: mutation.id,
      version: version || mutation.version,
      ...(stateErrorCode ? { errorCode: stateErrorCode } : {}),
      updatedAt: iso(this.now)
    };
    await this.options.store.putState(state);
    await this.options.store.appendHistory({
      id: `${state.updatedAt}:${mutation.id}:${status}`,
      mutationId: mutation.id,
      entityKey: state.key,
      status,
      at: state.updatedAt,
      ...(stateErrorCode ? { errorCode: stateErrorCode } : {})
    });
    this.emit();
    return state;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
