import { describe, expect, it } from 'vitest';
import {
  LatestMeterFrameBuffer,
  MeterFrameRateGate
} from '../src';

describe('meter transport pressure control', () => {
  it('drops intermediate telemetry but retains the newest frame', () => {
    const buffer = new LatestMeterFrameBuffer();
    buffer.push({
      providerInstanceId: 'sim',
      sequence: 1,
      capturedAt: 1,
      channels: []
    });
    buffer.push({
      providerInstanceId: 'sim',
      sequence: 2,
      capturedAt: 2,
      channels: []
    });

    expect(buffer.takeLatest()?.sequence).toBe(2);
    expect(buffer.stats().dropped).toBe(1);
  });

  it('rate limits visual telemetry independently of commands', () => {
    const gate = new MeterFrameRateGate(20);
    expect(gate.shouldSend(1000)).toBe(true);
    expect(gate.shouldSend(1020)).toBe(false);
    expect(gate.shouldSend(1050)).toBe(true);
  });
});
