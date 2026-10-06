import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type IdempotencyStatus = 'pending' | 'completed';

interface IdempotencyEntry<T> {
  status: IdempotencyStatus;
  value?: T;
  expiresAt: number;
}

interface IdempotencyFile<T> {
  version: 2;
  entries: Array<{
    key: string;
    status: IdempotencyStatus;
    value?: T;
    expiresAt: number;
  }>;
}

/**
 * Durable idempotency ledger for Live commands.
 *
 * A record is written as "pending" before provider execution. If the Node crashes
 * while the provider outcome is unknown, the same idempotency key is not replayed
 * automatically after restart; it becomes an explicit uncertain attempt instead.
 * Completed results are cached and returned for retries.
 */
export class IdempotencyStore<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 1000,
    private readonly filePath?: string
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;

    if (!this.filePath) {
      this.loaded = true;
      return;
    }

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<IdempotencyFile<T>>;
      const now = Date.now();
      const entries = parsed.version === 2 && Array.isArray(parsed.entries)
        ? parsed.entries
        : [];

      for (const entry of entries) {
        if (
          entry &&
          typeof entry.key === 'string' &&
          (entry.status === 'pending' || entry.status === 'completed') &&
          Number.isFinite(entry.expiresAt) &&
          entry.expiresAt > now
        ) {
          this.entries.set(entry.key, {
            status: entry.status,
            value: entry.value,
            expiresAt: entry.expiresAt
          });
        }
      }

      this.trimToMaxEntries();
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    this.loaded = true;
  }

  get(key: string): T | undefined {
    if (this.filePath && !this.loaded) {
      throw new Error('idempotency_store_not_loaded');
    }

    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.status === 'completed'
      ? entry.value
      : undefined;
  }

  isUncertain(key: string): boolean {
    if (this.filePath && !this.loaded) {
      throw new Error('idempotency_store_not_loaded');
    }

    const entry = this.entries.get(key);
    if (!entry) return false;

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return false;
    }

    return entry.status === 'pending';
  }

  async set(key: string, value: T): Promise<void> {
    await this.load();
    this.sweep();
    this.reserveSlot(key);
    this.entries.set(key, {
      status: 'completed',
      value,
      expiresAt: Date.now() + this.ttlMs
    });
    await this.queuePersist();
  }

  async run(key: string, producer: () => Promise<T>): Promise<T> {
    await this.load();

    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    if (this.isUncertain(key)) {
      throw new Error('idempotency_previous_attempt_uncertain');
    }

    const task = (async () => {
      this.sweep();
      this.reserveSlot(key);
      this.entries.set(key, {
        status: 'pending',
        expiresAt: Date.now() + this.ttlMs
      });
      await this.queuePersist();

      try {
        const value = await producer();
        this.entries.set(key, {
          status: 'completed',
          value,
          expiresAt: Date.now() + this.ttlMs
        });
        await this.queuePersist();
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  private reserveSlot(key: string): void {
    if (this.entries.has(key) || this.entries.size < this.maxEntries) return;
    const oldest = this.entries.keys().next().value as string | undefined;
    if (oldest) this.entries.delete(oldest);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private trimToMaxEntries(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  private async queuePersist(): Promise<void> {
    if (!this.filePath) return;

    const operation = this.writeQueue
      .catch(() => undefined)
      .then(() => this.persist());

    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;

    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    const payload: IdempotencyFile<T> = {
      version: 2,
      entries: [...this.entries.entries()].map(([key, entry]) => ({
        key,
        status: entry.status,
        value: entry.value,
        expiresAt: entry.expiresAt
      }))
    };

    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
