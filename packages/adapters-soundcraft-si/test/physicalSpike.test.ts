import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SoundcraftPhysicalSpikeSession } from '../src';

describe('Soundcraft physical spike session', () => {
  it('records operator markers while declaring zero NestLive writes', async () => {
    const session = new SoundcraftPhysicalSpikeSession({
      venue: 'Industrial',
      consoleModel: 'Soundcraft Si Expression',
      port: 43804,
      captureFullPayload: true
    });

    await session.start();
    const marker = session.mark({
      action: 'Move physical channel 1 fader from -20 dB to -10 dB',
      expectedObservation: 'A repeatable frame delta appears'
    });
    expect(marker.frameIndex).toBe(0);

    const report = await session.stop();
    expect(report.writesPerformedByNestLive).toBe(0);
    expect(report.markers).toHaveLength(1);
  });

  it('exports evidence atomically', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-sc-'));
    const file = path.join(dir, 'spike.json');
    const session = new SoundcraftPhysicalSpikeSession({
      port: 43805
    });

    try {
      await session.start();
      session.mark({ action: 'Observe idle console traffic' });
      await session.saveReport(file);
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.writesPerformedByNestLive).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
