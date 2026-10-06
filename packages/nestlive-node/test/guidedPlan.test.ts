import { describe, expect, it } from 'vitest';
import {
  buildGuidedNetworkPlan,
  buildPreDiscoveryNetworkPlan,
  parseWindowsNetworkSnapshot
} from '../src';

describe('Windows multi-network guided setup', () => {
  const interfaces = parseWindowsNetworkSnapshot(
    'node-industrial',
    [
      {
        InterfaceAlias: 'Ethernet',
        InterfaceIndex: 4,
        IPv4Address: { IPAddress: '10.0.0.20', PrefixLength: 24 },
        IPv4DefaultGateway: { NextHop: '10.0.0.1' },
        NetAdapter: {
          MacAddress: 'AA-BB-CC-DD-EE-01',
          Status: 'Up'
        },
        InterfaceMetric: 10
      },
      {
        InterfaceAlias: 'USB Wi-Fi',
        InterfaceIndex: 12,
        IPv4Address: { IPAddress: '192.168.50.10', PrefixLength: 24 },
        IPv4DefaultGateway: [],
        NetAdapter: {
          MacAddress: 'AA-BB-CC-DD-EE-02',
          Status: 'Up'
        },
        InterfaceMetric: 35
      }
    ],
    new Date('2026-10-04T12:00:00Z')
  );

  it('chooses Ethernet for cloud and USB Wi-Fi before console discovery', () => {
    const plan = buildPreDiscoveryNetworkPlan(interfaces);
    expect(plan.cloudInterfaceId).toContain('Ethernet');
    expect(plan.audioInterfaceId).toContain('USB Wi-Fi');
    expect(plan.readyForReadOnlyProbe).toBe(true);
  });

  it('keeps Ethernet for cloud and USB Wi-Fi for a known console', () => {
    const plan = buildGuidedNetworkPlan(
      interfaces,
      '192.168.50.2'
    );

    expect(plan.cloudInterfaceId).toContain('Ethernet');
    expect(plan.audioInterfaceId).toContain('USB Wi-Fi');
    expect(plan.readyForReadOnlyProbe).toBe(true);
    expect(
      plan.checks.find(check => check.id === 'isolation')?.severity
    ).toBe('ok');
  });

  it('does not silently mutate network when the audio subnet is missing', () => {
    const plan = buildGuidedNetworkPlan(
      interfaces,
      '172.20.50.2'
    );

    expect(plan.readyForReadOnlyProbe).toBe(false);
  });
});
