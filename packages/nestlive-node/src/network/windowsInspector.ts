import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkInterface } from '@millionsnest/nestlive-domain';
import { enumerateNetworkInterfaces } from './interfaces';

const execFileAsync = promisify(execFile);

interface WindowsInterfaceRecord {
  InterfaceAlias?: string;
  InterfaceIndex?: number;
  IPv4Address?: Array<{ IPAddress?: string; PrefixLength?: number }> | { IPAddress?: string; PrefixLength?: number };
  IPv4DefaultGateway?: Array<{ NextHop?: string }> | { NextHop?: string };
  NetAdapter?: { MacAddress?: string; Status?: string };
  InterfaceMetric?: number;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseWindowsNetworkSnapshot(
  nodeId: string,
  records: WindowsInterfaceRecord[],
  now = new Date()
): NetworkInterface[] {
  const raw = Object.fromEntries(
    records.map(record => {
      const alias = record.InterfaceAlias ?? `Interface ${record.InterfaceIndex ?? '?'}`;
      const addresses = asArray(record.IPv4Address)
        .filter(item => item.IPAddress)
        .map(item => ({
          address: item.IPAddress!,
          family: 'IPv4' as const,
          internal: false,
          mac: record.NetAdapter?.MacAddress,
          cidr:
            item.PrefixLength === undefined
              ? null
              : `${item.IPAddress}/${item.PrefixLength}`
        }));
      return [alias, addresses];
    })
  );

  const base = enumerateNetworkInterfaces(nodeId, raw, now);

  return base.map(item => {
    const record = records.find(
      candidate => candidate.InterfaceAlias === item.systemName
    );
    return {
      ...item,
      gateway: asArray(record?.IPv4DefaultGateway)
        .map(gateway => gateway.NextHop)
        .filter((value): value is string => Boolean(value)),
      macAddress:
        record?.NetAdapter?.MacAddress?.replaceAll('-', ':').toLowerCase() ??
        item.macAddress,
      metric: record?.InterfaceMetric,
      status:
        record?.NetAdapter?.Status?.toLowerCase() === 'up'
          ? 'online'
          : item.status
    };
  });
}

export async function inspectWindowsNetworkInterfaces(
  nodeId: string
): Promise<NetworkInterface[]> {
  const script = [
    "$configs = Get-NetIPConfiguration | ForEach-Object {",
    "  $metric = (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty InterfaceMetric)",
    "  [PSCustomObject]@{",
    "    InterfaceAlias = $_.InterfaceAlias;",
    "    InterfaceIndex = $_.InterfaceIndex;",
    "    IPv4Address = $_.IPv4Address;",
    "    IPv4DefaultGateway = $_.IPv4DefaultGateway;",
    "    NetAdapter = $_.NetAdapter;",
    "    InterfaceMetric = $metric",
    "  }",
    "}",
    "$configs | ConvertTo-Json -Depth 6 -Compress"
  ].join("\n");

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    }
  );

  const parsed = JSON.parse(stdout.trim()) as
    | WindowsInterfaceRecord
    | WindowsInterfaceRecord[];

  return parseWindowsNetworkSnapshot(
    nodeId,
    asArray(parsed)
  );
}
