import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

export interface HiqnetFrameEvidence {
  transport: 'udp' | 'tcp';
  direction: 'received';
  remoteAddress: string;
  remotePort: number;
  capturedAt: string;
  bytes: number;
  sha256: string;
  hexPrefix: string;
  hexPayload?: string;
}

export interface HiqnetCaptureHarnessOptions {
  localAddress?: string;
  port?: number;
  onFrame?: (frame: HiqnetFrameEvidence) => void;
  captureFullPayload?: boolean;
  maxFrames?: number;
}

/**
 * Physical-spike harness for Soundcraft Si/HiQnet environments.
 *
 * This intentionally does not attempt undocumented writes. It gives the
 * Industrial spike a reproducible way to observe whether the console is
 * reaching the NestLive machine over UDP/TCP and to preserve evidence.
 */
export class HiqnetCaptureHarness {
  private readonly port: number;
  private readonly udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  private readonly tcp = net.createServer();
  private readonly frames: HiqnetFrameEvidence[] = [];
  private readonly maxFrames: number;
  private droppedFrames = 0;
  private started = false;

  constructor(private readonly options: HiqnetCaptureHarnessOptions = {}) {
    this.port = options.port ?? 3804;
    this.maxFrames = Math.max(
      100,
      Math.min(500_000, options.maxFrames ?? 100_000)
    );
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.udp.on('message', (message, remote) => {
      this.record('udp', message, remote.address, remote.port);
    });

    this.tcp.on('connection', socket => {
      socket.on('data', message => {
        this.record(
          'tcp',
          message,
          socket.remoteAddress ?? 'unknown',
          socket.remotePort ?? 0
        );
      });
    });

    await Promise.all([
      new Promise<void>((resolve, reject) => {
        this.udp.once('error', reject);
        this.udp.bind(
          this.port,
          this.options.localAddress,
          () => resolve()
        );
      }),
      new Promise<void>((resolve, reject) => {
        this.tcp.once('error', reject);
        this.tcp.listen(
          this.port,
          this.options.localAddress,
          () => resolve()
        );
      })
    ]);

    this.started = true;
  }

  snapshot(): HiqnetFrameEvidence[] {
    return this.frames.map(frame => ({ ...frame }));
  }

  stats(): {
    capturedFrames: number;
    droppedFrames: number;
    port: number;
    started: boolean;
  } {
    return {
      capturedFrames: this.frames.length,
      droppedFrames: this.droppedFrames,
      port: this.port,
      started: this.started
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await Promise.all([
      new Promise<void>(resolve => this.udp.close(() => resolve())),
      new Promise<void>((resolve, reject) =>
        this.tcp.close(error => (error ? reject(error) : resolve()))
      )
    ]);
    this.started = false;
  }

  private record(
    transport: 'udp' | 'tcp',
    message: Uint8Array,
    remoteAddress: string,
    remotePort: number
  ): void {
    const bytes = Buffer.from(message);
    const frame: HiqnetFrameEvidence = {
      transport,
      direction: 'received',
      remoteAddress,
      remotePort,
      capturedAt: new Date().toISOString(),
      bytes: message.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      hexPrefix: bytes.subarray(0, 32).toString('hex'),
      ...(this.options.captureFullPayload
        ? { hexPayload: bytes.toString('hex') }
        : {})
    };

    if (this.frames.length >= this.maxFrames) {
      this.frames.shift();
      this.droppedFrames += 1;
    }
    this.frames.push(frame);
    this.options.onFrame?.({ ...frame });
  }
}
