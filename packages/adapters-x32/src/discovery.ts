import dgram from 'node:dgram';
import { decodeOscMessage, encodeOscMessage } from './osc';

function ipv4ToInt(value: string): number {
  const parts = value.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error('invalid_ipv4');
  }

  return (
    ((((parts[0] ?? 0) << 24) >>> 0) +
      ((parts[1] ?? 0) << 16) +
      ((parts[2] ?? 0) << 8) +
      (parts[3] ?? 0)) >>>
    0
  );
}

function intToIpv4(value: number): string {
  const unsigned = value >>> 0;
  return [
    (unsigned >>> 24) & 255,
    (unsigned >>> 16) & 255,
    (unsigned >>> 8) & 255,
    unsigned & 255
  ].join('.');
}

export function ipv4HostsInCidr(
  cidr: string,
  maxHosts = 512
): string[] {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('invalid_ipv4_cidr');
  }

  const ip = ipv4ToInt(address);
  const hostBits = 32 - prefix;
  const total = 2 ** hostBits;
  const usable = prefix >= 31 ? total : Math.max(0, total - 2);

  if (usable > maxHosts) {
    throw new Error('x32_discovery_subnet_too_large');
  }

  const mask =
    prefix === 0 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = (ip & mask) >>> 0;
  const first = prefix >= 31 ? network : network + 1;
  const lastExclusive =
    prefix >= 31 ? network + total : network + total - 1;

  const hosts: string[] = [];
  for (let value = first; value < lastExclusive; value += 1) {
    hosts.push(intToIpv4(value));
  }
  return hosts;
}

export interface DiscoveredX32 {
  address: string;
  networkName?: string;
  model?: string;
  firmware?: string;
  latencyMs: number;
}

export async function discoverX32OnSubnet(input: {
  localAddress: string;
  cidr: string;
  port?: number;
  timeoutMs?: number;
}): Promise<DiscoveredX32[]> {
  const port = input.port ?? 10023;
  const timeoutMs = Math.max(250, Math.min(3000, input.timeoutMs ?? 1000));
  const hosts = ipv4HostsInCidr(input.cidr).filter(
    host => host !== input.localAddress
  );
  const socket = dgram.createSocket('udp4');
  const payload = encodeOscMessage('/xinfo');
  const started = Date.now();
  const results = new Map<string, DiscoveredX32>();

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, input.localAddress, () => resolve());
  });

  socket.on('message', (bytes, remote) => {
    try {
      const message = decodeOscMessage(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      );
      if (message.address !== '/xinfo') return;
      const strings = message.args
        .filter(arg => arg.type === 's')
        .map(arg => (arg as { type: 's'; value: string }).value);

      results.set(remote.address, {
        address: remote.address,
        networkName: strings[1],
        model: strings[2],
        firmware: strings[3],
        latencyMs: Date.now() - started
      });
    } catch {
      // Ignore unrelated UDP traffic on the local socket.
    }
  });

  try {
    const batchSize = 64;
    for (let offset = 0; offset < hosts.length; offset += batchSize) {
      const batch = hosts.slice(offset, offset + batchSize);
      await Promise.all(
        batch.map(
          host =>
            new Promise<void>(resolve => {
              socket.send(payload, port, host, () => resolve());
            })
        )
      );
    }

    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return [...results.values()].sort((a, b) =>
      a.address.localeCompare(b.address, undefined, { numeric: true })
    );
  } finally {
    socket.close();
  }
}
