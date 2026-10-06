import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  LiveCollaborationGrant,
  LiveCollaborationInvite,
  LiveCollaborationRole,
  PairingBinding
} from '@millionsnest/nestlive-production-domain';

interface PersistedInvite {
  invite: LiveCollaborationInvite;
  secretHash: string;
}

interface PersistedGrant {
  tokenHash: string;
  binding: PairingBinding;
  grant: LiveCollaborationGrant;
  revokedAt?: string;
}

interface CollaborationFile {
  version: 1;
  invites: PersistedInvite[];
  grants: PersistedGrant[];
}

export interface CollaborationInviteSecret {
  invite: LiveCollaborationInvite;
  secret: string;
}

export interface CollaborationAuthorization {
  binding: PairingBinding;
  grant: LiveCollaborationGrant;
}

export interface CollaborationRedeemResult extends CollaborationAuthorization {
  token: string;
}

const EMPTY_FILE: CollaborationFile = {
  version: 1,
  invites: [],
  grants: []
};

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function permissionsForRole(role: LiveCollaborationRole): LiveCollaborationGrant['permissions'] {
  if (role === 'pastor') {
    return [
      'request.bible',
      'request.song',
      'request.media',
      'request.message',
      'presence.write',
      'chat.write'
    ];
  }
  if (role === 'conductor') {
    return [
      'request.song',
      'request.section',
      'request.message',
      'presence.write',
      'chat.write'
    ];
  }
  return ['presence.write', 'chat.write'];
}

export class CollaborationInviteStore {
  private file: CollaborationFile = structuredClone(EMPTY_FILE);
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly nodeId: string
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as CollaborationFile;
      this.file = parsed.version === 1 && Array.isArray(parsed.invites) && Array.isArray(parsed.grants)
        ? parsed
        : structuredClone(EMPTY_FILE);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.file = structuredClone(EMPTY_FILE);
    }
    this.loaded = true;
    if (this.prune()) await this.persist();
  }

  async createInvite(input: {
    binding: PairingBinding;
    liveSessionId: string;
    role: LiveCollaborationRole;
    createdBy: string;
    ttlMs?: number;
    maxUses?: number;
  }): Promise<CollaborationInviteSecret> {
    await this.load();
    if (!input.liveSessionId.trim()) throw new Error('collaboration_session_required');
    if (!input.createdBy.trim()) throw new Error('collaboration_creator_required');

    const ttlMs = Math.max(5 * 60_000, Math.min(input.ttlMs ?? 6 * 60 * 60_000, 12 * 60 * 60_000));
    const maxUses = Math.max(1, Math.min(input.maxUses ?? 8, 50));
    const now = Date.now();
    const invite: LiveCollaborationInvite = {
      id: randomBytes(18).toString('base64url'),
      organizationId: input.binding.organizationId,
      venueId: input.binding.venueId,
      liveSystemId: input.binding.liveSystemId,
      liveSessionId: input.liveSessionId,
      role: input.role,
      createdBy: input.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      maxUses,
      uses: 0
    };
    const secret = randomBytes(32).toString('base64url');
    this.file.invites.push({
      invite,
      secretHash: hashSecret(secret)
    });
    this.prune();
    await this.persist();
    return { invite: structuredClone(invite), secret };
  }

  async redeem(input: {
    inviteId: string;
    secret: string;
    actorId: string;
    deviceId: string;
    deviceName: string;
  }): Promise<CollaborationRedeemResult> {
    await this.load();
    const record = this.file.invites.find(item => item.invite.id === input.inviteId);
    if (!record || record.invite.revokedAt) throw new Error('collaboration_invite_invalid');
    if (Date.parse(record.invite.expiresAt) <= Date.now()) {
      throw new Error('collaboration_invite_expired');
    }
    if (record.invite.uses >= record.invite.maxUses) {
      throw new Error('collaboration_invite_exhausted');
    }
    if (!input.actorId.trim() || !input.deviceId.trim() || !input.deviceName.trim()) {
      throw new Error('collaboration_identity_required');
    }
    const provided = hashSecret(input.secret);
    if (!safeEqualHex(record.secretHash, provided)) {
      throw new Error('collaboration_invite_invalid');
    }

    const token = randomBytes(32).toString('base64url');
    const grant: LiveCollaborationGrant = {
      inviteId: record.invite.id,
      liveSessionId: record.invite.liveSessionId,
      role: record.invite.role,
      actorId: input.actorId,
      expiresAt: record.invite.expiresAt,
      permissions: permissionsForRole(record.invite.role)
    };
    const now = new Date().toISOString();
    const binding: PairingBinding = {
      nodeId: this.nodeId,
      organizationId: record.invite.organizationId,
      venueId: record.invite.venueId,
      liveSystemId: record.invite.liveSystemId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      pairedAt: now,
      lastSeenAt: now
    };

    record.invite.uses += 1;
    this.file.grants.push({
      tokenHash: hashSecret(token),
      binding,
      grant
    });
    this.prune();
    await this.persist();
    return {
      token,
      binding: structuredClone(binding),
      grant: structuredClone(grant)
    };
  }

  async authorize(token: string): Promise<CollaborationAuthorization | null> {
    await this.load();
    if (!token) return null;
    const tokenHash = hashSecret(token);
    const now = Date.now();
    const match = this.file.grants.find(item =>
      !item.revokedAt &&
      Date.parse(item.grant.expiresAt) > now &&
      safeEqualHex(item.tokenHash, tokenHash)
    );
    if (!match) return null;
    return {
      binding: structuredClone(match.binding),
      grant: structuredClone(match.grant)
    };
  }

  async revokeSession(liveSessionId: string): Promise<number> {
    await this.load();
    const now = new Date().toISOString();
    let count = 0;
    for (const invite of this.file.invites) {
      if (invite.invite.liveSessionId === liveSessionId && !invite.invite.revokedAt) {
        invite.invite.revokedAt = now;
        count += 1;
      }
    }
    for (const grant of this.file.grants) {
      if (grant.grant.liveSessionId === liveSessionId && !grant.revokedAt) {
        grant.revokedAt = now;
      }
    }
    if (count > 0) await this.persist();
    return count;
  }

  async listActive(liveSessionId?: string): Promise<LiveCollaborationInvite[]> {
    await this.load();
    const now = Date.now();
    return this.file.invites
      .map(item => item.invite)
      .filter(invite =>
        !invite.revokedAt &&
        Date.parse(invite.expiresAt) > now &&
        invite.uses < invite.maxUses &&
        (!liveSessionId || invite.liveSessionId === liveSessionId)
      )
      .map(item => structuredClone(item));
  }

  private prune(): boolean {
    const now = Date.now();
    const beforeInvites = this.file.invites.length;
    const beforeGrants = this.file.grants.length;
    this.file.invites = this.file.invites.filter(item =>
      Date.parse(item.invite.expiresAt) > now || Boolean(item.invite.revokedAt)
    ).slice(-200);
    this.file.grants = this.file.grants.filter(item =>
      Date.parse(item.grant.expiresAt) > now || Boolean(item.revokedAt)
    ).slice(-500);
    return beforeInvites !== this.file.invites.length || beforeGrants !== this.file.grants.length;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
