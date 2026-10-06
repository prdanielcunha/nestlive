import dgram from 'node:dgram';

export const NESTLIVE_DISCOVERY_GROUP = '239.255.43.17';
export const NESTLIVE_DISCOVERY_PORT = 4318;

export interface NestLiveDiscoveryBeacon {
  protocol: 'nestlive-node';
  protocolVersion: 1;
  nodeId: string;
  displayName: string;
  httpPort: number;
  meterPort: number;
  version: string;
  sentAt: string;
}

export interface DiscoveryBroadcasterOptions {
  nodeId: string;
  displayName: string;
  httpPort: number;
  meterPort: number;
  version: string;
  localAddress?: string;
  intervalMs?: number;
}

export class NestLiveDiscoveryBroadcaster {
  private readonly socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  private timer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(private readonly options: DiscoveryBroadcasterOptions) {}

  async start(): Promise<void> {
    if (this.started) return;

    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(0, this.options.localAddress, () => resolve());
    });

    this.socket.setMulticastTTL(1);
    if (this.options.localAddress) {
      this.socket.setMulticastInterface(this.options.localAddress);
    }

    this.started = true;
    this.broadcast();
    this.timer = setInterval(
      () => this.broadcast(),
      this.options.intervalMs ?? 2000
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>(resolve => this.socket.close(() => resolve()));
    this.started = false;
  }

  private broadcast(): void {
    const beacon: NestLiveDiscoveryBeacon = {
      protocol: 'nestlive-node',
      protocolVersion: 1,
      nodeId: this.options.nodeId,
      displayName: this.options.displayName,
      httpPort: this.options.httpPort,
      meterPort: this.options.meterPort,
      version: this.options.version,
      sentAt: new Date().toISOString()
    };
    const payload = Buffer.from(JSON.stringify(beacon), 'utf8');

    this.socket.send(
      payload,
      NESTLIVE_DISCOVERY_PORT,
      NESTLIVE_DISCOVERY_GROUP,
      () => undefined
    );
  }
}

export function parseDiscoveryBeacon(
  payload: Uint8Array
): NestLiveDiscoveryBeacon | undefined {
  try {
    const value = JSON.parse(Buffer.from(payload).toString('utf8')) as
      Partial<NestLiveDiscoveryBeacon>;
    if (
      value.protocol !== 'nestlive-node' ||
      value.protocolVersion !== 1 ||
      typeof value.nodeId !== 'string' ||
      typeof value.displayName !== 'string' ||
      typeof value.httpPort !== 'number' ||
      typeof value.meterPort !== 'number' ||
      typeof value.version !== 'string' ||
      typeof value.sentAt !== 'string'
    ) {
      return undefined;
    }
    return value as NestLiveDiscoveryBeacon;
  } catch {
    return undefined;
  }
}
