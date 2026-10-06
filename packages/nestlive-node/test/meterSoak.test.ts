import { describe, expect, it } from 'vitest';
import { LatestMeterFrameBuffer, MeterEngine } from '../src';

describe('meter engine one-hour logical soak', () => {
  it('processes 32 channels at 30fps without stale state or queue growth', () => {
    const engine = new MeterEngine();
    const buffer = new LatestMeterFrameBuffer();
    const fps = 30;
    const frames = 60 * 60 * fps;
    const intervalMs = 1000 / fps;
    let now = 1_000_000;

    for (let sequence = 1; sequence <= frames; sequence += 1) {
      now += intervalMs;
      const frame = {
        providerInstanceId: 'x32-soak',
        sequence,
        capturedAt: now,
        channels: Array.from({ length: 32 }, (_, index) => ({
          id: `ch-${String(index + 1).padStart(2, '0')}`,
          peakDb:
            -45 +
            ((sequence + index * 11) % 4300) / 100,
          clip: (sequence + index) % 997 === 0
        }))
      };

      engine.ingest(frame, now);
      buffer.push(frame);

      // Simulate a UI consumer slower than the console without allowing
      // telemetry to become an unbounded queue.
      if (sequence % 3 === 0 && sequence !== frames) {
        buffer.takeLatest();
      }
    }

    const latest = buffer.takeLatest();
    const snapshot = engine.snapshot(now + 100);

    expect(latest?.sequence).toBe(frames);
    expect(snapshot.stale).toBe(false);
    expect(snapshot.channels).toHaveLength(32);
    expect(snapshot.sequence).toBe(frames);
    expect(buffer.stats().received).toBe(frames);
    expect(buffer.stats().published).toBeLessThanOrEqual(
      buffer.stats().received
    );
    expect(buffer.stats().dropped).toBeGreaterThan(0);
  }, 20_000);
});
