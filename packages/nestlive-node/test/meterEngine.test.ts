import { describe, expect, it } from 'vitest';
import { MeterEngine, classifyMeter } from '../src';

describe('MeterEngine', () => {
  it('distinguishes silence from frozen telemetry', () => {
    const engine = new MeterEngine({ staleAfterMs: 500 });

    engine.ingest({
      providerInstanceId: 'sim',
      sequence: 1,
      capturedAt: 1000,
      channels: [{ id: 'ch-1', peakDb: -96 }]
    });

    expect(
      engine.snapshot(1200).channels[0]?.state
    ).toBe('silent');

    expect(
      engine.snapshot(1700).channels[0]?.state
    ).toBe('stale');
  });

  it('holds peaks while smoothing display', () => {
    const engine = new MeterEngine({ peakHoldMs: 900 });

    const first = engine.ingest({
      providerInstanceId: 'sim',
      sequence: 1,
      capturedAt: 1000,
      channels: [{ id: 'ch-1', peakDb: -4 }]
    });

    const second = engine.ingest({
      providerInstanceId: 'sim',
      sequence: 2,
      capturedAt: 1100,
      channels: [{ id: 'ch-1', peakDb: -30 }]
    });

    expect(first.channels[0]?.peakHoldDb).toBe(-4);
    expect(second.channels[0]?.peakHoldDb).toBe(-4);
    expect(second.channels[0]?.displayDb).toBeGreaterThan(-30);
  });

  it('uses semantic states instead of color alone', () => {
    expect(classifyMeter(-11, false, false)).toBe('healthy');
    expect(classifyMeter(0.2, true, false)).toBe('clip');
    expect(classifyMeter(-96, false, true)).toBe('stale');
  });
});
