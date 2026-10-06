import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { LiveDropAsset, LiveDropStatus } from '@millionsnest/nestlive-production-domain';

interface StoredLiveDropAsset extends LiveDropAsset {
  storageName: string;
}

interface LiveDropStateFile {
  version: 1 | 2;
  assets: StoredLiveDropAsset[];
  retention?: LiveDropRetentionPolicy;
}

export interface LiveDropScope {
  organizationId: string;
  venueId: string;
  liveSystemId: string;
}

export interface LiveDropUploadInput extends LiveDropScope {
  nodeId: string;
  fileName: string;
  contentType?: string;
  uploadedBy: string;
}

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const DEFAULT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REJECTED_TTL_MS = 60 * 60 * 1000;

export interface LiveDropRetentionPolicy {
  quarantineTtlMs: number;
  rejectedTtlMs: number;
  readyTtlMs: number | null;
}

export type LiveDropRetentionPreset = 'service' | 'week' | 'keep';

const DEFAULT_RETENTION_POLICY: LiveDropRetentionPolicy = {
  quarantineTtlMs: DEFAULT_QUARANTINE_TTL_MS,
  rejectedTtlMs: DEFAULT_REJECTED_TTL_MS,
  readyTtlMs: null
};

export function retentionPolicyForPreset(
  preset: LiveDropRetentionPreset
): LiveDropRetentionPolicy {
  const readyTtlMs =
    preset === 'service'
      ? 24 * 60 * 60 * 1000
      : preset === 'week'
        ? 7 * 24 * 60 * 60 * 1000
        : null;

  return {
    quarantineTtlMs: DEFAULT_QUARANTINE_TTL_MS,
    rejectedTtlMs: DEFAULT_REJECTED_TTL_MS,
    readyTtlMs
  };
}

function normalizeRetentionPolicy(
  value: Partial<LiveDropRetentionPolicy> | undefined,
  fallback: LiveDropRetentionPolicy = DEFAULT_RETENTION_POLICY
): LiveDropRetentionPolicy {
  const positiveOrDefault = (candidate: number | undefined, defaultValue: number) =>
    Number.isFinite(candidate) && Number(candidate) > 0
      ? Math.floor(Number(candidate))
      : defaultValue;

  const readyCandidate = value?.readyTtlMs;
  const readyTtlMs =
    readyCandidate === null
      ? null
      : Number.isFinite(readyCandidate) && Number(readyCandidate) > 0
        ? Math.floor(Number(readyCandidate))
        : fallback.readyTtlMs;

  return {
    quarantineTtlMs: positiveOrDefault(
      value?.quarantineTtlMs,
      fallback.quarantineTtlMs
    ),
    rejectedTtlMs: positiveOrDefault(
      value?.rejectedTtlMs,
      fallback.rejectedTtlMs
    ),
    readyTtlMs
  };
}

const EXTENSIONS: Record<
  string,
  {
    mediaType: LiveDropAsset['mediaType'];
    contentTypes: string[];
    fallbackContentType: string;
  }
> = {
  '.jpg': {
    mediaType: 'image',
    contentTypes: ['image/jpeg'],
    fallbackContentType: 'image/jpeg'
  },
  '.jpeg': {
    mediaType: 'image',
    contentTypes: ['image/jpeg'],
    fallbackContentType: 'image/jpeg'
  },
  '.png': {
    mediaType: 'image',
    contentTypes: ['image/png'],
    fallbackContentType: 'image/png'
  },
  '.webp': {
    mediaType: 'image',
    contentTypes: ['image/webp'],
    fallbackContentType: 'image/webp'
  },
  '.gif': {
    mediaType: 'image',
    contentTypes: ['image/gif'],
    fallbackContentType: 'image/gif'
  },
  '.mp4': {
    mediaType: 'video',
    contentTypes: ['video/mp4', 'application/mp4'],
    fallbackContentType: 'video/mp4'
  },
  '.mov': {
    mediaType: 'video',
    contentTypes: ['video/quicktime'],
    fallbackContentType: 'video/quicktime'
  },
  '.webm': {
    mediaType: 'video',
    contentTypes: ['video/webm'],
    fallbackContentType: 'video/webm'
  },
  '.mp3': {
    mediaType: 'audio',
    contentTypes: ['audio/mpeg'],
    fallbackContentType: 'audio/mpeg'
  },
  '.wav': {
    mediaType: 'audio',
    contentTypes: ['audio/wav', 'audio/x-wav'],
    fallbackContentType: 'audio/wav'
  },
  '.m4a': {
    mediaType: 'audio',
    contentTypes: ['audio/mp4', 'audio/x-m4a'],
    fallbackContentType: 'audio/mp4'
  },
  '.aac': {
    mediaType: 'audio',
    contentTypes: ['audio/aac'],
    fallbackContentType: 'audio/aac'
  },
  '.ogg': {
    mediaType: 'audio',
    contentTypes: ['audio/ogg'],
    fallbackContentType: 'audio/ogg'
  },
  '.flac': {
    mediaType: 'audio',
    contentTypes: ['audio/flac'],
    fallbackContentType: 'audio/flac'
  },
  '.pdf': {
    mediaType: 'pdf',
    contentTypes: ['application/pdf'],
    fallbackContentType: 'application/pdf'
  }
};

function publicAsset(
  asset: StoredLiveDropAsset,
  retention?: LiveDropRetentionPolicy
): LiveDropAsset {
  const { storageName: _storageName, ...safe } = asset;
  if (
    !safe.expiresAt &&
    safe.status === 'ready' &&
    retention?.readyTtlMs
  ) {
    const base = Date.parse(safe.reviewedAt || safe.uploadedAt);
    if (Number.isFinite(base)) {
      return {
        ...safe,
        expiresAt: new Date(base + retention.readyTtlMs).toISOString()
      };
    }
  }
  return safe;
}

function sanitizeFileName(value: string): string {
  const raw = value.trim();
  if (!raw || raw.length > 220) throw new Error('invalid_live_drop_file_name');

  const slashNormalized = raw.replace(/\\/g, '/');
  if (slashNormalized.includes('/') || basename(slashNormalized) !== slashNormalized) {
    throw new Error('invalid_live_drop_file_name');
  }

  const sanitized = raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('invalid_live_drop_file_name');
  }
  return sanitized;
}

function validateContentType(
  extension: string,
  contentType: string | undefined
): string {
  const definition = EXTENSIONS[extension];
  if (!definition) throw new Error('live_drop_file_type_not_allowed');

  const normalized = (String(contentType || '').split(';')[0] || '')
    .trim()
    .toLowerCase();

  if (
    normalized &&
    normalized !== 'application/octet-stream' &&
    !definition.contentTypes.includes(normalized)
  ) {
    throw new Error('live_drop_content_type_mismatch');
  }

  return normalized || definition.fallbackContentType;
}

function expiresAtFrom(
  now: number,
  status: LiveDropStatus,
  policy: LiveDropRetentionPolicy
): string | null {
  if (status === 'quarantined') {
    return new Date(now + policy.quarantineTtlMs).toISOString();
  }
  if (status === 'rejected') {
    return new Date(now + policy.rejectedTtlMs).toISOString();
  }
  if (status === 'ready' && policy.readyTtlMs) {
    return new Date(now + policy.readyTtlMs).toISOString();
  }
  return null;
}

function scopeMatches(asset: LiveDropAsset, scope: LiveDropScope): boolean {
  return (
    asset.organizationId === scope.organizationId &&
    asset.venueId === scope.venueId &&
    asset.liveSystemId === scope.liveSystemId
  );
}

export class LiveDropStore {
  private loaded = false;
  private assets: StoredLiveDropAsset[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly defaultRetention: LiveDropRetentionPolicy;
  private retentionPolicy: LiveDropRetentionPolicy;

  constructor(
    private readonly rootDir: string,
    private readonly metadataPath = join(rootDir, 'index.json'),
    private readonly maxBytes = DEFAULT_MAX_BYTES,
    retention?: Partial<LiveDropRetentionPolicy>
  ) {
    this.defaultRetention = normalizeRetentionPolicy(retention);
    this.retentionPolicy = { ...this.defaultRetention };
  }

  get retention(): LiveDropRetentionPolicy {
    return { ...this.retentionPolicy };
  }

  async setRetentionPreset(
    preset: LiveDropRetentionPreset
  ): Promise<LiveDropRetentionPolicy> {
    return this.setRetention(retentionPolicyForPreset(preset));
  }

  async setRetention(
    retention: LiveDropRetentionPolicy
  ): Promise<LiveDropRetentionPolicy> {
    const next = normalizeRetentionPolicy(retention, this.defaultRetention);

    await this.mutate(() => {
      this.retentionPolicy = next;
      this.assets = this.assets.map(asset => {
        const parsedBase = Date.parse(
          asset.status === 'quarantined'
            ? asset.uploadedAt
            : asset.reviewedAt || asset.uploadedAt
        );
        const base = Number.isFinite(parsedBase) ? parsedBase : Date.now();
        return {
          ...asset,
          expiresAt: expiresAtFrom(base, asset.status, next)
        };
      });
    });

    await this.purgeExpired();
    return this.retention;
  }

  async list(scope: LiveDropScope): Promise<LiveDropAsset[]> {
    await this.load();
    await this.purgeExpired();
    return this.assets
      .filter(asset => scopeMatches(asset, scope))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .map(asset => publicAsset(asset, this.retentionPolicy));
  }

  async get(id: string, scope: LiveDropScope): Promise<LiveDropAsset | null> {
    await this.load();
    const asset = this.assets.find(
      candidate => candidate.id === id && scopeMatches(candidate, scope)
    );
    return asset ? publicAsset(asset, this.retentionPolicy) : null;
  }

  async upload(
    input: LiveDropUploadInput,
    chunks: AsyncIterable<Uint8Array | string>
  ): Promise<LiveDropAsset> {
    const fileName = sanitizeFileName(input.fileName);
    const extension = extname(fileName).toLowerCase();
    const definition = EXTENSIONS[extension];
    if (!definition) throw new Error('live_drop_file_type_not_allowed');

    const contentType = validateContentType(extension, input.contentType);
    const id = randomUUID();
    const storageName = `${id}${extension}`;
    const quarantineDir = join(this.rootDir, 'quarantine');
    const tempPath = join(quarantineDir, `${storageName}.part`);
    const finalPath = join(quarantineDir, storageName);

    await mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    const handle = await open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let completed = false;

    try {
      for await (const chunk of chunks) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.from(chunk);
        sizeBytes += buffer.length;
        if (sizeBytes > this.maxBytes) {
          throw new Error('live_drop_file_too_large');
        }
        hash.update(buffer);
        await handle.write(buffer);
      }

      if (sizeBytes <= 0) throw new Error('live_drop_empty_file');
      await handle.close();
      await rename(tempPath, finalPath);
      completed = true;
    } finally {
      if (!completed) {
        await handle.close().catch(() => undefined);
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }

    const now = Date.now();
    const asset: StoredLiveDropAsset = {
      id,
      organizationId: input.organizationId,
      venueId: input.venueId,
      liveSystemId: input.liveSystemId,
      nodeId: input.nodeId,
      fileName,
      mediaType: definition.mediaType,
      contentType,
      sizeBytes,
      sha256: hash.digest('hex'),
      status: 'quarantined',
      uploadedAt: new Date(now).toISOString(),
      uploadedBy: input.uploadedBy,
      reviewedAt: null,
      reviewedBy: null,
      expiresAt: expiresAtFrom(now, 'quarantined', this.retentionPolicy),
      storageName
    };

    try {
      await this.mutate(() => {
        this.assets.unshift(asset);
      });
    } catch (error) {
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return publicAsset(asset, this.retentionPolicy);
  }

  async review(
    id: string,
    scope: LiveDropScope,
    status: 'ready' | 'rejected',
    reviewedBy: string
  ): Promise<LiveDropAsset> {
    let result!: StoredLiveDropAsset;

    await this.mutate(async () => {
      const index = this.assets.findIndex(
        asset => asset.id === id && scopeMatches(asset, scope)
      );
      if (index < 0) throw new Error('live_drop_asset_not_found');

      const current = this.assets[index]!;
      if (current.status === status) {
        result = current;
        return;
      }
      if (current.status !== 'quarantined') {
        throw new Error('live_drop_asset_not_quarantined');
      }

      const quarantinePath = join(this.rootDir, 'quarantine', current.storageName);
      const now = Date.now();

      if (status === 'ready') {
        const cacheDir = join(this.rootDir, 'cache');
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await rename(quarantinePath, join(cacheDir, current.storageName));
      } else {
        await rm(quarantinePath, { force: true });
      }

      const next: StoredLiveDropAsset = {
        ...current,
        status,
        reviewedAt: new Date(now).toISOString(),
        reviewedBy,
        expiresAt: expiresAtFrom(now, status, this.retentionPolicy)
      };
      this.assets[index] = next;
      result = next;
    });

    return publicAsset(result, this.retentionPolicy);
  }

  async resolveReadyPath(
    id: string,
    scope: LiveDropScope
  ): Promise<{ asset: LiveDropAsset; path: string }> {
    await this.load();
    const asset = this.assets.find(
      candidate => candidate.id === id && scopeMatches(candidate, scope)
    );
    if (!asset) throw new Error('live_drop_asset_not_found');
    if (asset.status !== 'ready') throw new Error('live_drop_asset_not_ready');

    return {
      asset: publicAsset(asset, this.retentionPolicy),
      path: join(this.rootDir, 'cache', asset.storageName)
    };
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    await this.load();
    const expired = this.assets.filter(asset => {
      const expiresAt = publicAsset(asset, this.retentionPolicy).expiresAt;
      if (!expiresAt) return false;
      const time = Date.parse(expiresAt);
      return Number.isFinite(time) && time <= now;
    });
    if (!expired.length) return 0;

    await this.mutate(async () => {
      const expiredIds = new Set(expired.map(asset => asset.id));
      for (const asset of expired) {
        const folder = asset.status === 'quarantined' ? 'quarantine' : 'cache';
        await rm(join(this.rootDir, folder, asset.storageName), { force: true })
          .catch(() => undefined);
      }
      this.assets = this.assets.filter(asset => !expiredIds.has(asset.id));
    });
    return expired.length;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.metadataPath, 'utf8');
      const parsed = JSON.parse(raw) as LiveDropStateFile;
      this.assets = Array.isArray(parsed.assets)
        ? parsed.assets.filter(asset =>
            asset &&
            typeof asset.id === 'string' &&
            typeof asset.storageName === 'string' &&
            typeof asset.organizationId === 'string' &&
            typeof asset.venueId === 'string' &&
            typeof asset.liveSystemId === 'string'
          )
        : [];
      if (parsed.retention) {
        this.retentionPolicy = normalizeRetentionPolicy(
          parsed.retention,
          this.defaultRetention
        );
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.assets = [];
    }
    this.loaded = true;
  }

  private async mutate(mutator: () => void | Promise<void>): Promise<void> {
    let resolveResult!: () => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<void>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.load();
        await mutator();
        await this.persist();
        resolveResult();
      })
      .catch(error => {
        rejectResult(error);
      });

    return result;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    const temp = `${this.metadataPath}.tmp`;
    const payload: LiveDropStateFile = {
      version: 2,
      assets: this.assets,
      retention: this.retentionPolicy
    };
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(temp, this.metadataPath);
  }
}
