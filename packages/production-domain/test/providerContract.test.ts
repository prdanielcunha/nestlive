import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  type LiveCommand,
  type ProviderAdapter
} from '../src';

describe('NestLive production-domain contract', () => {
  it('keeps providers capability-driven', () => {
    expect(CAPABILITIES).toContain('presentation.take');
    expect(CAPABILITIES).toContain('visual.clip.trigger');
  });

  it('keeps command envelope provider-neutral', () => {
    const command: LiveCommand = {
      id: 'cmd-1',
      correlationId: 'corr-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      liveSystemId: 'system-1',
      liveSessionId: 'session-1',
      actorId: 'operator-1',
      origin: 'live-ui',
      capability: 'presentation.take',
      targetProviderIds: ['provider-1'],
      outputTargets: ['main'],
      payload: { cueId: 'cue-1' },
      idempotencyKey: 'idem-1',
      createdAt: new Date(0).toISOString(),
      safetyLevel: 'normal'
    };
    expect(command.payload).toEqual({ cueId: 'cue-1' });
    const _typeOnly: ProviderAdapter | undefined = undefined;
    expect(_typeOnly).toBeUndefined();
  });
});
