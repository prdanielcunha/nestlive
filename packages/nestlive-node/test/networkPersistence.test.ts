import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NetworkBindingStore,
  classifyNetworkHealth,
  validateProviderBinding
} from '../src';

describe('network binding persistence and health', () => {
  it('persists a binding across store instances', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-'));
    const file = path.join(dir, 'bindings.json');
    const binding = {
      providerInstanceId: 'x32',
      networkInterfaceId: 'node:usb',
      localAddress: '192.168.32.10',
      targetAddress: '192.168.32.2',
      transport: 'udp' as const,
      discoveryMethod: 'automatic' as const,
      lastValidatedAt: '2026-10-04T12:00:00Z',
      health: 'unknown' as const
    };

    try {
      await new NetworkBindingStore(file).save(binding);
      expect(
        await new NetworkBindingStore(file).get('x32')
      ).toEqual(binding);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks missing adapters offline without mutating system network', async () => {
    const binding = {
      providerInstanceId: 'x32',
      networkInterfaceId: 'node:usb',
      localAddress: '192.168.32.10',
      targetAddress: '192.168.32.2',
      transport: 'udp' as const,
      discoveryMethod: 'automatic' as const,
      lastValidatedAt: '2026-10-04T12:00:00Z',
      health: 'unknown' as const
    };

    const checked = await validateProviderBinding(
      binding,
      undefined,
      async () => ({
        reachable: true,
        checkedAt: 'never'
      }),
      new Date('2026-10-04T12:01:00Z')
    );

    expect(checked.health).toBe('offline');
    expect(classifyNetworkHealth({
      reachable: true,
      latencyMs: 140,
      packetLossPercent: 0,
      checkedAt: 'now'
    })).toBe('degraded');
  });
});
