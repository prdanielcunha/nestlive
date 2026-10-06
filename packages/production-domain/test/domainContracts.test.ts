import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/types';
import {
  MUSICSCALE_LIVE_ADAPTER_SDK_VERSION,
  MUSICSCALE_LIVE_DOMAIN_CONTRACT_VERSION
} from '../src/version';
import { LIVE_ERROR_CODES } from '../src/errors';

describe('Phase 0 contracts', () => {
  it('publishes an explicit v1 compatibility boundary', () => {
    expect(MUSICSCALE_LIVE_DOMAIN_CONTRACT_VERSION).toBe(1);
    expect(MUSICSCALE_LIVE_ADAPTER_SDK_VERSION).toBe(1);
  });

  it('keeps capability names provider-neutral', () => {
    const serialized = CAPABILITIES.join(' ').toLowerCase();
    expect(serialized).not.toContain('holyrics');
    expect(serialized).not.toContain('propresenter');
    expect(serialized).not.toContain('resolume');
  });

  it('has deterministic command-path error codes', () => {
    expect(LIVE_ERROR_CODES).toContain('capability_not_supported');
    expect(LIVE_ERROR_CODES).toContain('provider_timeout');
    expect(LIVE_ERROR_CODES).toContain('node_not_paired');
    expect(LIVE_ERROR_CODES).toContain('state_diverged');
  });
});
