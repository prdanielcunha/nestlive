import { describe, expect, it } from 'vitest';
import { SimulatedAudioConsoleProvider } from '../src';

describe('SimulatedAudioConsoleProvider', () => {
  it('generates monotonic meter sequences', () => {
    const provider = new SimulatedAudioConsoleProvider();
    const first = provider.nextMeterFrame(100);
    const second = provider.nextMeterFrame(200);

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.capturedAt).toBe(200);
    expect(second.channels).toHaveLength(3);
  });

  it('returns observed state after a fader command', async () => {
    const provider = new SimulatedAudioConsoleProvider();
    const result = await provider.setFader('ch-01', -8);
    const channels = await provider.getChannels();

    expect(result.accepted).toBe(true);
    expect(channels[0]?.faderDb).toBe(-8);
  });
});
