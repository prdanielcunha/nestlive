import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AccessTokenBinding {
  nodeId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  lastSeenAt: string;
}

export interface AccessTokenRecord {
  id: string;
  deviceName: string;
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  binding?: AccessTokenBinding;
}

interface AccessTokenFile {
  version: 1;
  tokens: AccessTokenRecord[];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AccessTokenStore {
  constructor(private readonly filePath: string) {}

  async list(): Promise<AccessTokenRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AccessTokenFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.tokens)) {
        throw new Error('access_token_store_invalid');
      }
      return parsed.tokens;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
  }

  async issue(
    deviceName: string,
    ttlMs?: number,
    binding?: AccessTokenBinding
  ): Promise<{
    id: string;
    token: string;
    expiresAt?: string;
  }> {
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(12).toString('hex');
    const now = new Date();
    const expiresAt =
      ttlMs === undefined
        ? undefined
        : new Date(now.getTime() + ttlMs).toISOString();

    const records = await this.list();
    records.push({
      id,
      deviceName,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt,
      binding
    });
    await this.write(records);

    return { id, token, expiresAt };
  }

  async authorize(
    token: string,
    now = new Date()
  ): Promise<AccessTokenRecord | undefined> {
    if (!token) return undefined;
    const candidate = hashToken(token);
    const records = await this.list();

    return records.find(record => {
      if (record.revokedAt) return false;
      if (
        record.expiresAt &&
        new Date(record.expiresAt).getTime() <= now.getTime()
      ) {
        return false;
      }
      return equalHex(candidate, record.tokenHash);
    });
  }

  async authenticate(token: string, now = new Date()): Promise<boolean> {
    return Boolean(await this.authorize(token, now));
  }

  async revokeToken(token: string): Promise<boolean> {
    const record = await this.authorize(token);
    return record ? this.revoke(record.id) : false;
  }

  async activeCount(now = new Date()): Promise<number> {
    const records = await this.list();
    return records.filter(record => {
      if (record.revokedAt) return false;
      return !record.expiresAt ||
        new Date(record.expiresAt).getTime() > now.getTime();
    }).length;
  }

  async revoke(id: string): Promise<boolean> {
    const records = await this.list();
    let changed = false;
    const now = new Date().toISOString();
    const next = records.map(record => {
      if (record.id !== id || record.revokedAt) return record;
      changed = true;
      return { ...record, revokedAt: now };
    });
    if (changed) await this.write(next);
    return changed;
  }

  private async write(tokens: AccessTokenRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({ version: 1, tokens } satisfies AccessTokenFile, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temp, this.filePath);
  }
}
