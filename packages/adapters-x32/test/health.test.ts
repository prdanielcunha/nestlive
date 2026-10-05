import { describe, expect, it } from 'vitest';
import { sampleX32Reachability } from '../src';

describe('X32 network health sampling', () => {
  it('reports packet loss without failing the full sample', async () => {
    let attempt = 0;
    const sample = await sampleX32Reachability(
      async () => {
        attempt += 1;
        if (attempt === 2 || attempt === 5) {
          throw new Error('timeout');
        }
      },
      {
        attempts: 5,
        now: () => new Date('2026-10-05T02:00:00Z')
      }
    );

    expect(sample.reachable).toBe(true);
    expect(sample.attempts).toBe(5);
    expect(sample.successes).toBe(3);
    expect(sample.packetLossPercent).toBe(40);
    expect(sample.checkedAt).toBe('2026-10-05T02:00:00.000Z');
  });

  it('reports offline when every probe is lost', async () => {
    const sample = await sampleX32Reachability(
      async () => {
        throw new Error('timeout');
      },
      { attempts: 3 }
    );

    expect(sample.reachable).toBe(false);
    expect(sample.successes).toBe(0);
    expect(sample.packetLossPercent).toBe(100);
    expect(sample.latencyMs).toBeUndefined();
  });
});
