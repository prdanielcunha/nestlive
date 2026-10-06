import { describe, expect, it } from 'vitest';
import {
  validateNestLiveEcosystemContext
} from './ecosystemHandoff';

function base(now: number) {
  return {
    appId: 'nestlive',
    orgId: 'org-1',
    userId: 'user-1',
    customToken: 'custom-token',
    expiresAt: now + 300_000,
    supportMode: false,
    protocolVersion: '1.0.0'
  };
}

describe('NestLive ecosystem handoff', () => {
  it('accepts the canonical short-lived NestLive context', () => {
    const now = 1_800_000_000_000;
    expect(
      validateNestLiveEcosystemContext(base(now), now)
    ).toMatchObject({
      appId: 'nestlive',
      orgId: 'org-1',
      userId: 'user-1',
      protocolVersion: '1.0.0'
    });
  });

  it('rejects wrong app, expired contexts and oversized tokens', () => {
    const now = 1_800_000_000_000;
    expect(() =>
      validateNestLiveEcosystemContext(
        { ...base(now), appId: 'musicscale' },
        now
      )
    ).toThrow('ecosystem_handoff_app_mismatch');

    expect(() =>
      validateNestLiveEcosystemContext(
        { ...base(now), expiresAt: now - 1 },
        now
      )
    ).toThrow('ecosystem_handoff_expired_or_invalid');

    expect(() =>
      validateNestLiveEcosystemContext(
        {
          ...base(now),
          customToken: 'x'.repeat(16_385)
        },
        now
      )
    ).toThrow('ecosystem_handoff_token_invalid');
  });
});
