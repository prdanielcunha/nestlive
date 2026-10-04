import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RemoteMixGrant,
  RemoteMeterProfile
} from '@millionsnest/nestlive-domain';

interface StoredRemoteGrant {
  grant: RemoteMixGrant;
  tokenHash: string;
}

interface RemoteGrantFile {
  version: 1;
  grants: StoredRemoteGrant[];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface RemoteMixGrantRequest {
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  actorId: string;
  role: RemoteMixGrant['role'];
  permissions: RemoteMixGrant['permissions'];
  ttlMinutes?: number;
}

export interface IssuedRemoteMixGrant {
  grant: RemoteMixGrant;
  token: string;
}

export class RemoteMixAuthority {
  constructor(private readonly filePath: string) {}

  async issue(
    request: RemoteMixGrantRequest,
    now = new Date()
  ): Promise<IssuedRemoteMixGrant> {
    const ttlMinutes = Math.max(
      1,
      Math.min(240, Math.floor(request.ttlMinutes ?? 60))
    );
    const token = randomBytes(32).toString('base64url');
    const grant: RemoteMixGrant = {
      id: randomBytes(12).toString('hex'),
      organizationId: request.organizationId,
      venueId: request.venueId,
      liveSystemId: request.liveSystemId,
      actorId: request.actorId,
      role: request.role,
      permissions: [...new Set(request.permissions)],
      issuedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ttlMinutes * 60_000
      ).toISOString()
    };

    const current = await this.read();
    current.push({ grant, tokenHash: hash(token) });
    await this.write(current);
    return { grant, token };
  }

  async authenticate(
    token: string,
    now = new Date()
  ): Promise<RemoteMixGrant | undefined> {
    if (!token) return undefined;
    const candidate = hash(token);

    for (const item of await this.read()) {
      const grant = item.grant;
      if (grant.revokedAt) continue;
      if (new Date(grant.expiresAt).getTime() <= now.getTime()) continue;
      if (safeEqualHex(candidate, item.tokenHash)) {
        return { ...grant, permissions: [...grant.permissions] };
      }
    }
    return undefined;
  }

  async revoke(id: string, now = new Date()): Promise<boolean> {
    const current = await this.read();
    let changed = false;
    const next = current.map(item => {
      if (item.grant.id !== id || item.grant.revokedAt) return item;
      changed = true;
      return {
        ...item,
        grant: {
          ...item.grant,
          revokedAt: now.toISOString()
        }
      };
    });
    if (changed) await this.write(next);
    return changed;
  }

  async sweep(now = new Date()): Promise<number> {
    const current = await this.read();
    const next = current.filter(
      item =>
        !item.grant.revokedAt &&
        new Date(item.grant.expiresAt).getTime() > now.getTime()
    );
    const removed = current.length - next.length;
    if (removed > 0) await this.write(next);
    return removed;
  }

  private async read(): Promise<StoredRemoteGrant[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RemoteGrantFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.grants)) {
        throw new Error('remote_grant_store_invalid');
      }
      return parsed.grants;
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

  private async write(grants: StoredRemoteGrant[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({ version: 1, grants } satisfies RemoteGrantFile, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    await rename(temp, this.filePath);
  }
}

export interface RemoteMixRelaySession {
  sessionId: string;
  grantId: string;
  meterProfile: RemoteMeterProfile;
  openedAt: string;
  lastSeenAt: string;
}

/**
 * Cloud relay implementation remains outside the console adapter.
 * This contract keeps the console unreachable from the public internet:
 * cloud <-> authenticated Node session <-> bound LAN provider.
 */
export interface RemoteMixRelay {
  open(input: {
    grant: RemoteMixGrant;
    requestedMeterProfile: RemoteMeterProfile;
  }): Promise<RemoteMixRelaySession>;
  sendControl(input: {
    sessionId: string;
    payload: Uint8Array;
  }): Promise<void>;
  sendMeter(input: {
    sessionId: string;
    payload: Uint8Array;
  }): Promise<void>;
  close(sessionId: string): Promise<void>;
}
