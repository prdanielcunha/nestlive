import dgram, { type RemoteInfo, type Socket } from 'node:dgram';

const DEFAULT_GROUP = '239.255.43.17';
const DEFAULT_PORT = 4318;
const DEFAULT_BEACON_MS = 3000;
const DEFAULT_TTL_MS = 12_000;
const PRODUCT = 'NestLive Node';
const LEGACY_PRODUCTS = new Set(['MillionsNest Live Node']);
const PROTOCOL_VERSION = 1;

export interface DiscoveredLiveNode {
  nodeId: string;
  displayName: string;
  baseUrl: string;
  address: string;
  port: number;
  version?: string;
  lastSeenAt: string;
}

interface BeaconPayload {
  product: typeof PRODUCT;
  protocolVersion: typeof PROTOCOL_VERSION;
  nodeId: string;
  displayName: string;
  httpPort: number;
  version?: string;
}

export interface PeerDiscoveryOptions {
  nodeId: string;
  displayName: string;
  httpPort: number;
  version?: string;
  multicastGroup?: string;
  multicastPort?: number;
  beaconIntervalMs?: number;
  peerTtlMs?: number;
}

function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

export function parseDiscoveryBeacon(
  input: Uint8Array | string,
  remote: Pick<RemoteInfo, 'address'>
): Omit<DiscoveredLiveNode, 'lastSeenAt'> | null {
  try {
    const raw = typeof input === 'string'
      ? input
      : Buffer.from(input).toString('utf8');
    const payload = JSON.parse(raw) as Partial<BeaconPayload>;

    if (
      (payload.product !== PRODUCT && !LEGACY_PRODUCTS.has(String(payload.product || ''))) ||
      payload.protocolVersion !== PROTOCOL_VERSION ||
      typeof payload.nodeId !== 'string' ||
      !payload.nodeId.trim() ||
      typeof payload.displayName !== 'string' ||
      !payload.displayName.trim() ||
      !isValidPort(payload.httpPort)
    ) {
      return null;
    }

    const address = String(remote.address || '').replace(/^::ffff:/, '');
    if (!address) return null;

    return {
      nodeId: payload.nodeId.trim(),
      displayName: payload.displayName.trim(),
      address,
      port: payload.httpPort,
      baseUrl: `http://${address}:${payload.httpPort}`,
      version: typeof payload.version === 'string' ? payload.version : undefined
    };
  } catch {
    return null;
  }
}

export class PeerDiscovery {
  private readonly group: string;
  private readonly port: number;
  private readonly beaconIntervalMs: number;
  private readonly peerTtlMs: number;
  private socket: Socket | null = null;
  private beaconTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly peers = new Map<string, DiscoveredLiveNode>();
  private state: 'idle' | 'starting' | 'online' | 'unavailable' = 'idle';

  constructor(private readonly options: PeerDiscoveryOptions) {
    this.group = options.multicastGroup || DEFAULT_GROUP;
    this.port = options.multicastPort || DEFAULT_PORT;
    this.beaconIntervalMs = options.beaconIntervalMs || DEFAULT_BEACON_MS;
    this.peerTtlMs = options.peerTtlMs || DEFAULT_TTL_MS;
  }

  status(): 'idle' | 'starting' | 'online' | 'unavailable' {
    return this.state;
  }

  setDisplayName(displayName: string): void {
    const normalized = displayName.trim().replace(/\s+/g, ' ').slice(0, 64);
    if (normalized) this.options.displayName = normalized;
  }

  async start(): Promise<boolean> {
    if (this.socket) return this.state === 'online';
    this.state = 'starting';

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (message, remote) => {
      const parsed = parseDiscoveryBeacon(message, remote);
      if (!parsed || parsed.nodeId === this.options.nodeId) return;
      this.peers.set(parsed.nodeId, {
        ...parsed,
        lastSeenAt: new Date().toISOString()
      });
    });

    socket.on('error', error => {
      this.state = 'unavailable';
      console.log(JSON.stringify({
        event: 'peer_discovery_error',
        error: error.message
      }));
    });

    const online = await new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      socket.once('listening', () => {
        try {
          socket.setMulticastTTL(1);
          socket.setMulticastLoopback(false);
          socket.addMembership(this.group);
          this.state = 'online';
          finish(true);
        } catch (error) {
          this.state = 'unavailable';
          console.log(JSON.stringify({
            event: 'peer_discovery_membership_failed',
            error: error instanceof Error ? error.message : 'unknown'
          }));
          finish(false);
        }
      });

      socket.once('error', () => finish(false));

      try {
        socket.bind(this.port, '0.0.0.0');
      } catch {
        this.state = 'unavailable';
        finish(false);
      }
    });

    if (!online) return false;

    const sendBeacon = () => {
      if (!this.socket || this.state !== 'online') return;
      const payload: BeaconPayload = {
        product: PRODUCT,
        protocolVersion: PROTOCOL_VERSION,
        nodeId: this.options.nodeId,
        displayName: this.options.displayName,
        httpPort: this.options.httpPort,
        version: this.options.version
      };
      const data = Buffer.from(JSON.stringify(payload), 'utf8');
      this.socket.send(data, this.port, this.group, error => {
        if (error) {
          console.log(JSON.stringify({
            event: 'peer_discovery_beacon_failed',
            error: error.message
          }));
        }
      });
    };

    sendBeacon();
    this.beaconTimer = setInterval(sendBeacon, this.beaconIntervalMs);
    this.beaconTimer.unref();

    this.cleanupTimer = setInterval(() => this.prune(), Math.min(this.peerTtlMs, 5000));
    this.cleanupTimer.unref();

    console.log(JSON.stringify({
      event: 'peer_discovery_started',
      group: this.group,
      port: this.port
    }));

    return true;
  }

  list(): DiscoveredLiveNode[] {
    this.prune();
    return [...this.peers.values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  close(): void {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.beaconTimer = null;
    this.cleanupTimer = null;
    this.peers.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Best-effort shutdown.
      }
    }
    this.state = 'idle';
  }

  private prune(): void {
    const now = Date.now();
    for (const [nodeId, peer] of this.peers) {
      const seen = Date.parse(peer.lastSeenAt);
      if (!Number.isFinite(seen) || now - seen > this.peerTtlMs) {
        this.peers.delete(nodeId);
      }
    }
  }
}
