import { describe, expect, it } from 'vitest';
import {
  buildMixChannelViewModels,
  meterPercent,
  meterStatusText
} from './uiModel';

describe('Mix UI model', () => {
  it('keeps observed meter state separate from fader state', () => {
    const result = buildMixChannelViewModels(
      [
        {
          id: 'ch-01',
          name: 'Pastor',
          index: 1,
          faderDb: -3,
          mute: false
        }
      ],
      {
        providerInstanceId: 'x32',
        sequence: 1,
        capturedAt: 1,
        channels: [
          {
            id: 'ch-01',
            postFaderDb: -12,
            peakDb: -7
          }
        ]
      }
    );

    expect(result[0]?.faderDb).toBe(-3);
    expect(result[0]?.meterDb).toBe(-12);
  });

  it('never depends on color alone for meter status', () => {
    expect(
      meterStatusText({
        db: -12,
        clip: false,
        available: true,
        stale: false
      })
    ).toBe('Sinal saudável');
    expect(meterPercent(-60)).toBe(0);
    expect(meterPercent(0)).toBe(100);
  });
});
