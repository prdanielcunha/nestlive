import { randomBytes, randomInt } from 'node:crypto';
import type { AccessTokenStore } from './accessTokenStore';

export interface PairingChallenge {
  challengeId: string;
  deviceName: string;
  expiresAt: string;
  displayedOnNode: true;
}

interface InternalChallenge extends PairingChallenge {
  pin: string;
  attempts: number;
}

export interface PairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  onPin?: (input: {
    challengeId: string;
    deviceName: string;
    pin: string;
    expiresAt: string;
  }) => void;
}

export class PairingManager {
  private readonly challenges = new Map<string, InternalChallenge>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly tokens: AccessTokenStore,
    private readonly options: PairingManagerOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 2 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  create(deviceName: string, now = new Date()): PairingChallenge {
    const safeName = deviceName.trim().slice(0, 80);
    if (!safeName) throw new Error('pairing_device_name_required');

    this.sweep(now);
    const challengeId = randomBytes(16).toString('hex');
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    const challenge: InternalChallenge = {
      challengeId,
      deviceName: safeName,
      expiresAt,
      displayedOnNode: true,
      pin,
      attempts: 0
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
      displayedOnNode: true
    };
  }

  async complete(input: {
    challengeId: string;
    pin: string;
    now?: Date;
  }): Promise<{
    tokenId: string;
    token: string;
    deviceName: string;
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

    this.challenges.delete(challenge.challengeId);
    const issued = await this.tokens.issue(challenge.deviceName);

    return {
      tokenId: issued.id,
      token: issued.token,
      deviceName: challenge.deviceName
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
