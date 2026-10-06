import { describe, expect, it, vi } from 'vitest';
import {
  ResolumeRealtimeClient,
  type ResolumeRealtimeEvent
} from '../src/ResolumeRealtimeClient';

type Listener = (...args: any[]) => void;

class FakeSocket {
  readyState = 0;
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  addEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) || [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit('close');
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  message(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  error() {
    this.emit('error');
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

describe('ResolumeRealtimeClient', () => {
  it('connects to the official /api/v1 WebSocket endpoint', async () => {
    let socket: FakeSocket | null = null;
    let socketUrl = '';
    const events: ResolumeRealtimeEvent[] = [];

    const client = new ResolumeRealtimeClient({
      baseUrl: 'http://192.168.1.40:8080',
      webSocketFactory: url => {
        socketUrl = url;
        socket = new FakeSocket();
        return socket;
      }
    });

    const started = client.start(event => events.push(event));
    socket!.open();

    await expect(started).resolves.toBe(true);
    expect(socketUrl).toBe('ws://192.168.1.40:8080/api/v1');
    expect(client.isConnected()).toBe(true);
    expect(events.map(event => event.type)).toContain('open');
  });

  it('subscribes to connected clip parameters once and forwards updates', async () => {
    let socket!: FakeSocket;
    const events: ResolumeRealtimeEvent[] = [];
    const client = new ResolumeRealtimeClient({
      baseUrl: '127.0.0.1:8080',
      webSocketFactory: () => {
        socket = new FakeSocket();
        return socket;
      }
    });

    const started = client.start(event => events.push(event));
    socket.open();
    await started;

    const composition = {
      layers: [{
        id: 1,
        clips: [{
          id: 44,
          connected: { id: 9001, value: false }
        }]
      }]
    };

    socket.message(composition);
    socket.message(composition);
    socket.message({
      type: 'parameter_update',
      parameter: '/parameter/by-id/9001',
      value: true
    });

    expect(socket.sent).toEqual([
      JSON.stringify({
        action: 'subscribe',
        parameter: '/parameter/by-id/9001'
      })
    ]);
    expect(events.filter(event => event.type === 'message')).toHaveLength(3);
  });

  it('cleans up a failed socket and allows a later reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const client = new ResolumeRealtimeClient({
      baseUrl: '127.0.0.1:8080',
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    const first = client.start(() => undefined);
    sockets[0]!.error();
    await expect(first).resolves.toBe(false);
    expect(client.isConnected()).toBe(false);
    expect(sockets[0]!.closes[0]).toMatchObject({
      code: 1011,
      reason: 'realtime_error'
    });

    const second = client.start(() => undefined);
    sockets[1]!.open();
    await expect(second).resolves.toBe(true);
    expect(client.isConnected()).toBe(true);

    client.stop();
    expect(sockets[1]!.closes[0]).toMatchObject({
      code: 1000,
      reason: 'adapter_disposed'
    });
  });

  it('times out realtime without throwing so REST can remain the fallback', async () => {
    vi.useFakeTimers();
    try {
      let socket!: FakeSocket;
      const client = new ResolumeRealtimeClient({
        baseUrl: '127.0.0.1:8080',
        connectTimeoutMs: 100,
        webSocketFactory: () => {
          socket = new FakeSocket();
          return socket;
        }
      });

      const started = client.start(() => undefined);
      await vi.advanceTimersByTimeAsync(101);

      await expect(started).resolves.toBe(false);
      expect(client.isConnected()).toBe(false);
      expect(socket.closes[0]).toMatchObject({
        code: 1000,
        reason: 'connect_timeout'
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
