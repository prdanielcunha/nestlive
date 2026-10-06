import { describe, expect, it } from 'vitest';
import {
  AUDIO_CAPABILITIES,
  AUDIO_SAFETY_BY_CAPABILITY,
  type MeterFrame
} from '../src';

describe('NestLive audio contracts', () => {
  it('keeps meter frames provider-neutral', () => {
    const frame: MeterFrame = {
      providerInstanceId: 'console-1',
      sequence: 42,
      capturedAt: 1_700_000_000_000,
      channels: [{ id: 'ch-1', peakDb: -3.2, rmsDb: -11.4 }]
    };

    expect(frame.channels[0]?.id).toBe('ch-1');
    expect(JSON.stringify(frame).toLowerCase()).not.toContain('x32');
    expect(JSON.stringify(frame).toLowerCase()).not.toContain('soundcraft');
  });

  it('marks phantom and scene recall as critical', () => {
    expect(AUDIO_SAFETY_BY_CAPABILITY['audio.phantom.write']).toBe('critical');
    expect(AUDIO_SAFETY_BY_CAPABILITY['audio.scene.recall']).toBe('critical');
  });

  it('contains no duplicated capability ids', () => {
    expect(new Set(AUDIO_CAPABILITIES).size).toBe(AUDIO_CAPABILITIES.length);
  });
});
