import { describe, expect, it } from 'vitest';
import { ipv4HostsInCidr } from '../src';

describe('X32 safe subnet discovery', () => {
  it('enumerates usable addresses in a small dedicated subnet', () => {
    expect(ipv4HostsInCidr('192.168.32.10/30')).toEqual([
      '192.168.32.9',
      '192.168.32.10'
    ]);
  });

  it('refuses very large scans', () => {
    expect(() => ipv4HostsInCidr('10.0.0.20/16')).toThrow(
      'x32_discovery_subnet_too_large'
    );
  });

  it('supports the normal /24 router case', () => {
    const hosts = ipv4HostsInCidr('192.168.50.10/24');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.50.1');
    expect(hosts.at(-1)).toBe('192.168.50.254');
  });
});
