import { describe, expect, it } from 'vitest';
import {
  createProviderNetworkBinding,
  detectSubnetConflicts,
  enumerateNetworkInterfaces,
  findBindingCandidates
} from '../src';

describe('NestLive multi-network foundation', () => {
  const interfaces = enumerateNetworkInterfaces(
    'node-1',
    {
      Ethernet: [
        {
          address: '10.0.0.25',
          family: 'IPv4',
          internal: false,
          mac: '11:22:33:44:55:66',
          cidr: '10.0.0.25/24'
        }
      ],
      'USB Wi-Fi': [
        {
          address: '192.168.32.10',
          family: 'IPv4',
          internal: false,
          mac: '66:55:44:33:22:11',
          cidr: '192.168.32.10/24'
        }
      ]
    },
    new Date('2026-10-04T12:00:00Z')
  );

  it('finds the dedicated interface without creating a bridge', () => {
    const candidates = findBindingCandidates(
      interfaces,
      '192.168.32.2'
    );

    expect(candidates).toHaveLength(1);
    expect(
      candidates[0]?.networkInterface.systemName
    ).toBe('USB Wi-Fi');
    expect(candidates[0]?.localAddress).toBe('192.168.32.10');
  });

  it('creates an explicit provider binding', () => {
    const audioInterface = interfaces.find(
      item => item.systemName === 'USB Wi-Fi'
    );

    expect(audioInterface).toBeDefined();

    const binding = createProviderNetworkBinding({
      providerInstanceId: 'x32-monte',
      networkInterface: audioInterface!,
      localAddress: '192.168.32.10',
      targetAddress: '192.168.32.2',
      transport: 'udp',
      now: new Date('2026-10-04T12:00:00Z')
    });

    expect(binding.networkInterfaceId).toContain('USB Wi-Fi');
    expect(binding.health).toBe('unknown');
  });

  it('detects overlapping subnets', () => {
    const conflictSet = [
      ...interfaces,
      {
        ...interfaces[0]!,
        id: 'node-1:Other',
        systemName: 'Other',
        ipv4: ['10.0.0.50'],
        subnet: ['10.0.0.50/24']
      }
    ];

    expect(
      detectSubnetConflicts(conflictSet)
    ).not.toHaveLength(0);
  });
});
