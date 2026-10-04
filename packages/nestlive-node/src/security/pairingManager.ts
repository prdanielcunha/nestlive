import { randomBytes, randomInt } from 'node:crypto';
import type {
  AccessTokenBinding,
  AccessTokenStore
} from './accessTokenStore';

export interface PairingChallenge {
  challengeId: string;
  deviceName: string;
  expiresAt: string;
  displayedOnNode: true;
  nodeId?: string;
  method?: 'pin';
}

export interface PairingCreateInput {
  deviceId?: string;
  deviceName: string;
  organizationId?: string;
  venueId?: string;
  liveSystemId?: string;
}

interface InternalChallenge extends PairingChallenge {
  pin: string;
  attempts: number;
  deviceId?: string;
  organizationId?: string;
  venueId?: string;
  liveSystemId?: string;
}

export interface LocalPairingDisplay {
  challengeId: string;
  deviceName: string;
  pin: string;
  expiresAt: string;
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  maxConcurrent?: number;
  nodeId?: string;
  onPin?: (input: LocalPairingDisplay) => void;
}

export class PairingManager {
  private readonly challenges = new Map<string, InternalChallenge>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly maxConcurrent: number;

  constructor(
    private readonly tokens: AccessTokenStore,
    private readonly options: PairingManagerOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 2 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.maxConcurrent = options.maxConcurrent ?? 5;
  }

  create(
    input: string | PairingCreateInput,
    now = new Date()
  ): PairingChallenge {
    const request: PairingCreateInput =
      typeof input === 'string'
        ? { deviceName: input }
        : input;
    const safeName = request.deviceName.trim().slice(0, 80);
    if (!safeName) throw new Error('pairing_device_name_required');

    const scope = [
      request.organizationId,
      request.venueId,
      request.liveSystemId
    ];
    const scopeCount = scope.filter(value => Boolean(value?.trim())).length;
    if (scopeCount !== 0 && scopeCount !== 3) {
      throw new Error('pairing_scope_invalid');
    }

    this.sweep(now);
    if (this.challenges.size >= this.maxConcurrent) {
      throw new Error('pairing_too_many_pending');
    }

    const challengeId = randomBytes(16).toString('hex');
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    const challenge: InternalChallenge = {
      challengeId,
      deviceName: safeName,
      expiresAt,
      displayedOnNode: true,
      nodeId: this.options.nodeId,
      method: 'pin',
      pin,
      attempts: 0,
      deviceId: request.deviceId?.trim() || undefined,
      organizationId: request.organizationId?.trim() || undefined,
      venueId: request.venueId?.trim() || undefined,
      liveSystemId: request.liveSystemId?.trim() || undefined
    };
    this.challenges.set(challengeId, challenge);
    this.options.onPin?.({
      challengeId,
      deviceName: safeName,
      pin,
      expiresAt
    });

    return {
      challengeId,
      deviceName: safeName,
      expiresAt,
      displayedOnNode: true,
      nodeId: this.options.nodeId,
      method: 'pin'
    };
  }

  localDisplay(now = new Date()): LocalPairingDisplay[] {
    this.sweep(now);
    return [...this.challenges.values()].map(challenge => ({
      challengeId: challenge.challengeId,
      deviceName: challenge.deviceName,
      pin: challenge.pin,
      expiresAt: challenge.expiresAt
    }));
  }

  async complete(input: {
    challengeId: string;
    pin: string;
    deviceId?: string;
    deviceName?: string;
    now?: Date;
  }): Promise<{
    tokenId: string;
    token: string;
    deviceName: string;
    nodeId?: string;
    binding?: AccessTokenBinding;
  }> {
    const now = input.now ?? new Date();
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) throw new Error('pairing_challenge_not_found');

    if (new Date(challenge.expiresAt).getTime() <= now.getTime()) {
      this.challenges.delete(challenge.challengeId);
      throw new Error('pairing_challenge_expired');
    }

    challenge.attempts += 1;
    if (challenge.attempts > this.maxAttempts) {
      this.challenges.delete(challenge.challengeId);
      throw new Error('pairing_attempts_exceeded');
    }

    if (input.pin.replace(/\D/g, '') !== challenge.pin) {
      throw new Error('pairing_pin_invalid');
    }

    if (
      challenge.deviceId &&
      input.deviceId &&
      challenge.deviceId !== input.deviceId
    ) {
      throw new Error('pairing_device_mismatch');
    }
    if (
      input.deviceName &&
      challenge.deviceName !== input.deviceName.trim().slice(0, 80)
    ) {
      throw new Error('pairing_device_mismatch');
    }

    this.challenges.delete(challenge.challengeId);
    const pairedAt = now.toISOString();
    const hasScope = Boolean(
      challenge.organizationId &&
      challenge.venueId &&
      challenge.liveSystemId &&
      (challenge.deviceId || input.deviceId) &&
      this.options.nodeId
    );
    const binding: AccessTokenBinding | undefined = hasScope
      ? {
          nodeId: this.options.nodeId!,
          organizationId: challenge.organizationId!,
          venueId: challenge.venueId!,
          liveSystemId: challenge.liveSystemId!,
          deviceId: (challenge.deviceId || input.deviceId)!,
          deviceName: challenge.deviceName,
          pairedAt,
          lastSeenAt: pairedAt
        }
      : undefined;

    const issued = await this.tokens.issue(
      challenge.deviceName,
      undefined,
      binding
    );

    return {
      tokenId: issued.id,
      token: issued.token,
      deviceName: challenge.deviceName,
      nodeId: this.options.nodeId,
      binding
    };
  }

  sweep(now = new Date()): void {
    for (const [id, challenge] of this.challenges) {
      if (new Date(challenge.expiresAt).getTime() <= now.getTime()) {
        this.challenges.delete(id);
      }
    }
  }
}
