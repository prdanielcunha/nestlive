import { describe, expect, it } from 'vitest';
import { parseDiscoveryBeacon } from '../src/peerDiscovery';

describe('peer discovery beacon', () => {
  it('builds the LAN base URL from the packet sender instead of trusting a host from payload', () => {
    const payload = JSON.stringify({
      product: 'NestLive Node',
      protocolVersion: 1,
      nodeId: 'node_remote',
      displayName: 'PC Visual',
      httpPort: 4317,
      version: '0.1.0'
    });

    expect(parseDiscoveryBeacon(payload, { address: '192.168.1.44' })).toEqual({
      nodeId: 'node_remote',
      displayName: 'PC Visual',
      address: '192.168.1.44',
      port: 4317,
      baseUrl: 'http://192.168.1.44:4317',
      version: '0.1.0'
    });
  });

  it('normalizes IPv4-mapped addresses', () => {
    const payload = JSON.stringify({
      product: 'NestLive Node',
      protocolVersion: 1,
      nodeId: 'node_remote',
      displayName: 'PC Projeção',
      httpPort: 4317
    });

    expect(parseDiscoveryBeacon(payload, { address: '::ffff:10.0.0.25' })?.baseUrl)
      .toBe('http://10.0.0.25:4317');
  });

  it('accepts a legacy alpha product beacon during rolling upgrades', () => {
    const payload = JSON.stringify({
      product: 'MillionsNest Live Node',
      protocolVersion: 1,
      nodeId: 'node_legacy',
      displayName: 'PC Visual antigo',
      httpPort: 4317
    });

    expect(parseDiscoveryBeacon(payload, { address: '192.168.1.55' })?.baseUrl)
      .toBe('http://192.168.1.55:4317');
  });

  it('rejects unrelated or malformed multicast traffic', () => {
    expect(parseDiscoveryBeacon('{}', { address: '192.168.1.20' })).toBeNull();
    expect(parseDiscoveryBeacon('not-json', { address: '192.168.1.20' })).toBeNull();
    expect(parseDiscoveryBeacon(JSON.stringify({
      product: 'Other Product',
      protocolVersion: 1,
      nodeId: 'x',
      displayName: 'x',
      httpPort: 4317
    }), { address: '192.168.1.20' })).toBeNull();
  });
});
