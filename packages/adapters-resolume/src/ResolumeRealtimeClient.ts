import { normalizeResolumeApiUrl } from './ResolumeRestClient';

export interface ResolumeRealtimeEvent {
  type: 'open' | 'message' | 'close' | 'error';
  payload?: unknown;
  receivedAt: string;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ResolumeRealtimeClientOptions {
  baseUrl?: string;
  connectTimeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocketLike;
}

function toWebSocketUrl(input?: string): string {
  const url = new URL(normalizeResolumeApiUrl(input));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/\/$/, '');
}

function parseMessageData(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(data)) {
    try {
      return JSON.parse(new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      ));
    } catch {
      return null;
    }
  }
  return null;
}

function parameterId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const raw = record.id ?? record.uuid ?? record.identifier;
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
}

function collectConnectedParameterIds(
  value: unknown,
  output: Set<string>,
  depth = 0
): void {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectConnectedParameterIds(item, output, depth + 1);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key.toLowerCase() === 'connected') {
      const id = parameterId(child);
      if (id) output.add(id);
    }
    collectConnectedParameterIds(child, output, depth + 1);
  }
}

export class ResolumeRealtimeClient {
  private readonly url: string;
  private readonly connectTimeoutMs: number;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private socket: WebSocketLike | null = null;
  private subscribedParameterIds = new Set<string>();
  private generation = 0;
  private connecting: Promise<boolean> | null = null;

  constructor(options: ResolumeRealtimeClientOptions = {}) {
    this.url = toWebSocketUrl(options.baseUrl);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 1200;
    this.webSocketFactory = options.webSocketFactory || ((url: string) => new WebSocket(url));
  }

  isConnected(): boolean {
    return this.socket?.readyState === 1;
  }

  start(onEvent: (event: ResolumeRealtimeEvent) => void): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    if (this.connecting) return this.connecting;

    const generation = ++this.generation;
    this.subscribedParameterIds.clear();

    this.connecting = new Promise<boolean>(resolve => {
      let settled = false;
      let socket: WebSocketLike;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.connecting = null;
        resolve(value);
      };

      try {
        socket = this.webSocketFactory(this.url);
      } catch {
        this.socket = null;
        onEvent({ type: 'error', receivedAt: new Date().toISOString() });
        settle(false);
        return;
      }

      this.socket = socket;
      timeout = setTimeout(() => {
        if (generation !== this.generation) return;
        try {
          socket.close(1000, 'connect_timeout');
        } catch {
          // best effort
        }
        if (this.socket === socket) this.socket = null;
        settle(false);
      }, this.connectTimeoutMs);

      socket.addEventListener('open', () => {
        if (generation !== this.generation) return;
        onEvent({ type: 'open', receivedAt: new Date().toISOString() });
        settle(true);
      });

      socket.addEventListener('message', event => {
        if (generation !== this.generation) return;
        const payload = parseMessageData(event.data);
        if (payload === null) return;

        const ids = new Set<string>();
        collectConnectedParameterIds(payload, ids);
        for (const id of ids) this.subscribe(id);

        onEvent({
          type: 'message',
          payload,
          receivedAt: new Date().toISOString()
        });
      });

      socket.addEventListener('close', () => {
        if (generation !== this.generation) return;
        if (this.socket === socket) this.socket = null;
        this.subscribedParameterIds.clear();
        onEvent({ type: 'close', receivedAt: new Date().toISOString() });
        settle(false);
      });

      socket.addEventListener('error', () => {
        if (generation !== this.generation) return;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close(1011, 'realtime_error');
        } catch {
          // best effort
        }
        this.subscribedParameterIds.clear();
        onEvent({ type: 'error', receivedAt: new Date().toISOString() });
        settle(false);
      });
    });

    return this.connecting;
  }

  stop(): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    this.subscribedParameterIds.clear();
    if (!socket) return;
    try {
      socket.close(1000, 'adapter_disposed');
    } catch {
      // best effort
    }
  }

  private subscribe(parameterId: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.subscribedParameterIds.has(parameterId)) {
      return;
    }
    this.subscribedParameterIds.add(parameterId);
    socket.send(JSON.stringify({
      action: 'subscribe',
      parameter: `/parameter/by-id/${parameterId}`
    }));
  }
}
