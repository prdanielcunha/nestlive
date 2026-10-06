import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudioProviderConfigStore } from '../src';

describe('AudioProviderConfigStore', () => {
  it('recovers the X32 binding after a restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-audio-config-'));
    const file = path.join(dir, 'providers.json');

    try {
      const first = new AudioProviderConfigStore(file);
      await first.save({
        kind: 'x32',
        providerInstanceId: 'x32-primary',
        targetAddress: '192.168.32.2',
        localAddress: '192.168.32.10',
        networkInterfaceId: 'node:USB Wi-Fi',
        updatedAt: '2026-10-04T15:00:00Z'
      });

      const second = new AudioProviderConfigStore(file);
      expect(await second.list()).toEqual([
        expect.objectContaining({
          targetAddress: '192.168.32.2',
          localAddress: '192.168.32.10'
        })
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
