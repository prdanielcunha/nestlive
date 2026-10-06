import { WebSocket, WebSocketServer } from 'ws';
import type { MeterFrame } from '@millionsnest/nestlive-domain';

export interface MeterFrameEnvelope {
  type: 'meter.frame';
  frame: MeterFrame;
}

export class MeterFrameRateGate {
  private lastSentAt = 0;

  constructor(private readonly targetFps: number) {}

  shouldSend(now: number): boolean {
    if (this.targetFps <= 0) return false;
    const minInterval = 1000 / this.targetFps;
    if (now - this.lastSentAt < minInterval) return false;
    this.lastSentAt = now;
    return true;
  }
}

interface MeterClientState {
  socket: WebSocket;
  gate: MeterFrameRateGate;
}

export interface MeterWebSocketServerOptions {
  host?: string;
  port: number;
  authenticate: (token: string) => boolean | Promise<boolean>;
  targetFps?: number;
  maxBufferedBytes?: number;
}

export class MeterWebSocketServer {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<MeterClientState>();
  private readonly targetFps: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly options: MeterWebSocketServerOptions) {
    this.targetFps = options.targetFps ?? 30;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    this.server = new WebSocketServer({
      host: options.host ?? '0.0.0.0',
      port: options.port
    });

    this.server.on('connection', async (socket, request) => {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`
      );
      const token = url.searchParams.get('token') ?? '';
      const allowed = await this.options.authenticate(token);

      if (!allowed) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const state: MeterClientState = {
        socket,
        gate: new MeterFrameRateGate(this.targetFps)
      };
      this.clients.add(state);
      socket.on('close', () => this.clients.delete(state));
    });
  }

  publish(frame: MeterFrame, now = Date.now()): void {
    const payload = JSON.stringify({
      type: 'meter.frame',
      frame
    } satisfies MeterFrameEnvelope);

    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.socket.bufferedAmount > this.maxBufferedBytes) continue;
      if (!client.gate.shouldSend(now)) continue;
      client.socket.send(payload);
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.socket.close(1001, 'server_shutdown');
    }
    this.clients.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close(error => (error ? reject(error) : resolve()));
    });
  }
}
