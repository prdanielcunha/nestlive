import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccessTokenStore,
  PairingManager,
  parseDiscoveryBeacon
} from '../src';

describe('NestLive pairing and access tokens', () => {
  it('never persists plaintext bearer tokens', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-auth-'));
    const file = path.join(dir, 'tokens.json');
    try {
      const store = new AccessTokenStore(file);
      const issued = await store.issue('iPad operação');
      expect(await store.authenticate(issued.token)).toBe(true);
      expect(JSON.stringify(await store.list())).not.toContain(issued.token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requires the physically displayed PIN before issuing access', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nestlive-pair-'));
    const file = path.join(dir, 'tokens.json');
    let displayedPin = '';

    try {
      const manager = new PairingManager(
        new AccessTokenStore(file),
        {
          onPin: value => {
            displayedPin = value.pin;
          }
        }
      );

      const challenge = manager.create('iPad');
      expect(challenge).not.toHaveProperty('pin');
      await expect(
        manager.complete({
          challengeId: challenge.challengeId,
          pin: '000000'
        })
      ).rejects.toThrow('pairing_pin_invalid');

      const grant = await manager.complete({
        challengeId: challenge.challengeId,
        pin: displayedPin
      });
      expect(grant.token).toHaveLength(43);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed discovery beacons', () => {
    expect(parseDiscoveryBeacon(Buffer.from('{}'))).toBeUndefined();
    expect(
      parseDiscoveryBeacon(
        Buffer.from(
          JSON.stringify({
            protocol: 'nestlive-node',
            protocolVersion: 1,
            nodeId: 'node-1',
            displayName: 'Projection',
            httpPort: 4317,
            meterPort: 4319,
            version: '0.1.0',
            sentAt: new Date().toISOString()
          })
        )
      )?.nodeId
    ).toBe('node-1');
  });
});
