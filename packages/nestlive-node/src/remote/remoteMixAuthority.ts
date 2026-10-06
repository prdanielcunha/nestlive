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

const ROLE_PERMISSIONS: Record<
  RemoteMixGrant['role'],
  ReadonlySet<RemoteMixGrant['permissions'][number]>
> = {
  viewer: new Set(['audio.read']),
  operator: new Set([
    'audio.read',
    'audio.fader.write',
    'audio.mute.write',
    'audio.guarded.write'
  ]),
  technical_admin: new Set([
    'audio.read',
    'audio.fader.write',
    'audio.mute.write',
    'audio.guarded.write',
    'audio.critical.write'
  ])
};

function required(value: string, label: string): string {
  const next = String(value ?? '').trim();
  if (!next || next.length > 256) {
    throw new Error(`remote_grant_${label}_invalid`);
  }
  return next;
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
    const allowed = ROLE_PERMISSIONS[request.role];
    if (!allowed) throw new Error('remote_grant_role_invalid');
    const permissions = [...new Set(request.permissions)];
    if (
      permissions.length === 0 ||
      permissions.some(permission => !allowed.has(permission))
    ) {
      throw new Error('remote_grant_permission_not_allowed_for_role');
    }

    const token = randomBytes(32).toString('base64url');
    const grant: RemoteMixGrant = {
      id: randomBytes(12).toString('hex'),
      organizationId: required(request.organizationId, 'organization'),
      venueId: required(request.venueId, 'venue'),
      liveSystemId: required(request.liveSystemId, 'live_system'),
      actorId: required(request.actorId, 'actor'),
      role: request.role,
      permissions,
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

  async list(
    options: { includeExpired?: boolean } = {},
    now = new Date()
  ): Promise<RemoteMixGrant[]> {
    return (await this.read())
      .map(item => item.grant)
      .filter(grant => {
        if (options.includeExpired) return true;
        if (grant.revokedAt) return false;
        return new Date(grant.expiresAt).getTime() > now.getTime();
      })
      .map(grant => ({
        ...grant,
        permissions: [...grant.permissions]
      }));
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
