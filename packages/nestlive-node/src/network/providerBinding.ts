import type {
  NetworkInterface,
  ProviderNetworkBinding
} from '@millionsnest/nestlive-domain';
import { interfaceCanReachTargetBySubnet } from './interfaces';

export interface BindingCandidate {
  networkInterface: NetworkInterface;
  localAddress: string;
  reason: 'same_subnet';
}

export function findBindingCandidates(
  interfaces: NetworkInterface[],
  targetAddress: string
): BindingCandidate[] {
  return interfaces.flatMap(networkInterface => {
    if (!interfaceCanReachTargetBySubnet(networkInterface, targetAddress)) {
      return [];
    }

    return networkInterface.ipv4.map(localAddress => ({
      networkInterface,
      localAddress,
      reason: 'same_subnet' as const
    }));
  });
}

export function createProviderNetworkBinding(input: {
  providerInstanceId: string;
  networkInterface: NetworkInterface;
  localAddress: string;
  targetAddress: string;
  transport: ProviderNetworkBinding['transport'];
  discoveryMethod?: ProviderNetworkBinding['discoveryMethod'];
  now?: Date;
}): ProviderNetworkBinding {
  if (!input.networkInterface.ipv4.includes(input.localAddress)) {
    throw new Error('local_address_not_owned_by_interface');
  }

  if (
    !interfaceCanReachTargetBySubnet(
      input.networkInterface,
      input.targetAddress
    )
  ) {
    throw new Error('target_not_in_interface_subnet');
  }

  return {
    providerInstanceId: input.providerInstanceId,
    networkInterfaceId: input.networkInterface.id,
    localAddress: input.localAddress,
    targetAddress: input.targetAddress,
    transport: input.transport,
    discoveryMethod: input.discoveryMethod ?? 'automatic',
    lastValidatedAt: (input.now ?? new Date()).toISOString(),
    health: 'unknown'
  };
}
