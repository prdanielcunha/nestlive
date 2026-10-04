import dgram from 'node:dgram';
import {
  decodeOscMessage,
  encodeOscMessage,
  type OscArgument,
  type OscMessage
} from './osc';

export interface X32Transport {
  send(address: string, args?: OscArgument[]): Promise<void>;
  request(
    address: string,
    args?: OscArgument[],
    timeoutMs?: number
  ): Promise<OscMessage>;
  messages(signal?: AbortSignal): AsyncIterable<OscMessage>;
  close(): Promise<void>;
}

interface PendingRequest {
  address: string;
  resolve: (message: OscMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UdpX32TransportOptions {
  targetAddress: string;
  targetPort?: number;
  localAddress?: string;
  localPort?: number;
}

export class UdpX32Transport implements X32Transport {
  private readonly socket = dgram.createSocket('udp4');
  private readonly targetAddress: string;
  private readonly targetPort: number;
  private readonly localAddress?: string;
  private readonly localPort: number;
  private started = false;
  private pending: PendingRequest[] = [];
  private listeners = new Set<(message: OscMessage) => void>();

  constructor(options: UdpX32TransportOptions) {
    this.targetAddress = options.targetAddress;
    this.targetPort = options.targetPort ?? 10023;
    this.localAddress = options.localAddress;
    this.localPort = options.localPort ?? 0;
  }

  private async start(): Promise<void> {
    if (this.started) return;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.socket.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.off('error', onError);
        resolve();
      };

      this.socket.once('error', onError);
      this.socket.once('listening', onListening);
      this.socket.bind(this.localPort, this.localAddress);
    });

    this.socket.on('message', bytes => {
      let message: OscMessage;
      try {
        message = decodeOscMessage(
          new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        );
      } catch {
        return;
      }

      const pendingIndex = this.pending.findIndex(
        request => request.address === message.address
      );

      if (pendingIndex >= 0) {
        const request = this.pending.splice(pendingIndex, 1)[0];
        if (request) {
          clearTimeout(request.timer);
          request.resolve(message);
        }
      }

      for (const listener of this.listeners) listener(message);
    });

    this.started = true;
  }

  async send(
    address: string,
    args: OscArgument[] = []
  ): Promise<void> {
    await this.start();
    const payload = encodeOscMessage(address, args);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(
        payload,
        this.targetPort,
        this.targetAddress,
        error => (error ? reject(error) : resolve())
      );
    });
  }

  async request(
    address: string,
    args: OscArgument[] = [],
    timeoutMs = 500
  ): Promise<OscMessage> {
    await this.start();

    const reply = new Promise<OscMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex(
          item => item.resolve === resolve
        );
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error(`x32_timeout:${address}`));
      }, timeoutMs);

      this.pending.push({
        address,
        resolve,
        reject,
        timer
      });
    });

    await this.send(address, args);
    return reply;
  }

  async *messages(signal?: AbortSignal): AsyncIterable<OscMessage> {
    await this.start();
    const queue: OscMessage[] = [];
    let wake: (() => void) | undefined;

    const listener = (message: OscMessage) => {
      queue.push(message);
      wake?.();
      wake = undefined;
    };

    this.listeners.add(listener);

    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            wake = resolve;
            signal?.addEventListener('abort', resolve, { once: true });
          });
        }

        while (queue.length > 0) {
          const message = queue.shift();
          if (message) yield message;
        }
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  async close(): Promise<void> {
    for (const request of this.pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(new Error('x32_transport_closed'));
    }

    if (!this.started) return;

    await new Promise<void>(resolve => {
      this.socket.close(() => resolve());
    });
    this.started = false;
  }
}
