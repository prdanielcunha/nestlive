import type {
  NetworkHealth,
  NetworkInterface,
  ProviderNetworkBinding
} from '@millionsnest/nestlive-domain';

export interface ReachabilitySample {
  reachable: boolean;
  latencyMs?: number;
  packetLossPercent?: number;
  checkedAt: string;
}

export type ReachabilityProbe = (input: {
  localAddress: string;
  targetAddress: string;
  timeoutMs: number;
}) => Promise<ReachabilitySample>;

export function classifyNetworkHealth(
  sample: ReachabilitySample
): NetworkHealth {
  if (!sample.reachable) return 'offline';
  if (
    (sample.packetLossPercent ?? 0) > 3 ||
    (sample.latencyMs ?? 0) > 100
  ) {
    return 'degraded';
  }
  return 'online';
}

export async function validateProviderBinding(
  binding: ProviderNetworkBinding,
  networkInterface: NetworkInterface | undefined,
  probe: ReachabilityProbe,
  now = new Date()
): Promise<ProviderNetworkBinding> {
  if (!networkInterface) {
    return {
      ...binding,
      health: 'offline',
      lastValidatedAt: now.toISOString()
    };
  }

  if (!networkInterface.ipv4.includes(binding.localAddress)) {
    return {
      ...binding,
      health: 'offline',
      lastValidatedAt: now.toISOString()
    };
  }

  const sample = await probe({
    localAddress: binding.localAddress,
    targetAddress: binding.targetAddress,
    timeoutMs: 800
  });

  return {
    ...binding,
    health: classifyNetworkHealth(sample),
    lastValidatedAt: now.toISOString()
  };
}
