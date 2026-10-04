import os from 'node:os';
import type {
  NetworkInterface,
  NetworkInterfaceType
} from '@millionsnest/nestlive-domain';

export interface RawInterfaceAddress {
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  mac?: string;
  netmask?: string;
  cidr?: string | null;
}

export type RawInterfaceMap = Record<string, RawInterfaceAddress[] | undefined>;

function classifyInterface(name: string): NetworkInterfaceType {
  const normalized = name.toLowerCase();

  if (/virtual|vmware|hyper-v|vbox|loopback|docker|wsl|vethernet/.test(normalized)) {
    return 'virtual';
  }
  if (/usb/.test(normalized) && /wi-?fi|wireless|wlan|802\.11/.test(normalized)) {
    return 'usb_wifi';
  }
  if (/wi-?fi|wireless|wlan|802\.11/.test(normalized)) {
    return 'wifi';
  }
  if (/ethernet|eth\d|en\d|lan/.test(normalized)) {
    return 'ethernet';
  }
  return 'other';
}

function nodeInterfaceMap(): RawInterfaceMap {
  const entries = os.networkInterfaces();
  const mapped: RawInterfaceMap = {};

  for (const [name, addresses] of Object.entries(entries)) {
    mapped[name] = addresses?.map(item => ({
      address: item.address,
      family: item.family as 'IPv4' | 'IPv6',
      internal: item.internal,
      mac: item.mac,
      netmask: item.netmask,
      cidr: item.cidr
    }));
  }

  return mapped;
}

export function enumerateNetworkInterfaces(
  nodeId: string,
  source: RawInterfaceMap = nodeInterfaceMap(),
  now = new Date()
): NetworkInterface[] {
  return Object.entries(source)
    .filter(([, addresses]) => addresses?.some(address => !address.internal))
    .map(([systemName, addresses]) => {
      const external = (addresses ?? []).filter(address => !address.internal);
      const ipv4 = external
        .filter(address => address.family === 'IPv4')
        .map(address => address.address);
      const ipv6 = external
        .filter(address => address.family === 'IPv6')
        .map(address => address.address);
      const subnet = external
        .map(address => address.cidr)
        .filter((value): value is string => Boolean(value));
      const macAddress = external.find(
        address => address.mac && address.mac !== '00:00:00:00:00:00'
      )?.mac;

      return {
        id: `${nodeId}:${systemName}`,
        nodeId,
        systemName,
        humanName: systemName,
        type: classifyInterface(systemName),
        ipv4,
        ipv6,
        subnet,
        gateway: [],
        dns: [],
        macAddress,
        status: 'online',
        lastSeenAt: now.toISOString()
      };
    });
}

function ipv4ToInt(value: string): number | null {
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }

  return (
    (((octets[0] ?? 0) << 24) >>> 0) +
    ((octets[1] ?? 0) << 16) +
    ((octets[2] ?? 0) << 8) +
    (octets[3] ?? 0)
  );
}

function cidrContains(cidr: string, targetAddress: string): boolean {
  const [networkAddress, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const network = networkAddress ? ipv4ToInt(networkAddress) : null;
  const target = ipv4ToInt(targetAddress);

  if (
    network === null ||
    target === null ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (network & mask) === (target & mask);
}

export function interfaceCanReachTargetBySubnet(
  networkInterface: NetworkInterface,
  targetAddress: string
): boolean {
  return networkInterface.subnet.some(
    cidr => cidr.includes('.') && cidrContains(cidr, targetAddress)
  );
}

export interface SubnetConflict {
  cidrA: string;
  cidrB: string;
  interfaceIdA: string;
  interfaceIdB: string;
}

export function detectSubnetConflicts(
  interfaces: NetworkInterface[]
): SubnetConflict[] {
  const conflicts: SubnetConflict[] = [];

  for (let i = 0; i < interfaces.length; i += 1) {
    for (let j = i + 1; j < interfaces.length; j += 1) {
      const a = interfaces[i];
      const b = interfaces[j];
      if (!a || !b) continue;

      for (const cidrA of a.subnet.filter(cidr => cidr.includes('.'))) {
        const addressA = cidrA.split('/')[0];
        if (!addressA) continue;

        for (const cidrB of b.subnet.filter(cidr => cidr.includes('.'))) {
          const addressB = cidrB.split('/')[0];
          if (!addressB) continue;

          if (cidrContains(cidrA, addressB) || cidrContains(cidrB, addressA)) {
            conflicts.push({
              cidrA,
              cidrB,
              interfaceIdA: a.id,
              interfaceIdB: b.id
            });
          }
        }
      }
    }
  }

  return conflicts;
}
