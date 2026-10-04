import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';

export interface ControlProbe {
  reachable: boolean;
  version?: string;
  observed?: Record<string, unknown>;
  reason?: string;
}

export interface ControlInvocation {
  accepted: boolean;
  observed?: Record<string, unknown>;
  errorCode?: string;
  recoverable?: boolean;
}

export interface ProductionControlClient {
  probe(): Promise<ControlProbe>;
  getState?(): Promise<Record<string, unknown>>;
  invoke(action: string, payload: Record<string, unknown>): Promise<ControlInvocation>;
  dispose?(): Promise<void>;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 3000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function compactXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match?.[1]?.trim() || undefined;
}

export class VmixHttpControlClient implements ProductionControlClient {
  constructor(private readonly baseUrl: string) {}

  private apiUrl(params?: URLSearchParams): string {
    const base = this.baseUrl.replace(/\/$/, '');
    return params?.size ? `${base}/api/?${params.toString()}` : `${base}/api/`;
  }

  async probe(): Promise<ControlProbe> {
    try {
      const response = await fetchWithTimeout(this.apiUrl(), { method: 'GET' });
      if (!response.ok) throw new Error(`vmix_http_${response.status}`);
      const xml = await response.text();
      return {
        reachable: true,
        version: compactXmlValue(xml, 'version'),
        observed: {
          active: compactXmlValue(xml, 'active') || null,
          preview: compactXmlValue(xml, 'preview') || null,
          streaming: compactXmlValue(xml, 'streaming') || null,
          recording: compactXmlValue(xml, 'recording') || null
        }
      };
    } catch (error) {
      return {
        reachable: false,
        reason: error instanceof Error ? error.message : 'vmix_unreachable'
      };
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    const probe = await this.probe();
    if (!probe.reachable) throw new Error(probe.reason || 'vmix_unreachable');
    return probe.observed || {};
  }

  async invoke(action: string, payload: Record<string, unknown>): Promise<ControlInvocation> {
    const params = new URLSearchParams();
    params.set('Function', action);
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null || key === 'function') continue;
      params.set(key, String(value));
    }
    try {
      const response = await fetchWithTimeout(this.apiUrl(params), { method: 'GET' }, 5000);
      if (!response.ok) {
        return {
          accepted: false,
          errorCode: `vmix_http_${response.status}`,
          recoverable: response.status >= 500
        };
      }
      return { accepted: true, observed: await this.getState().catch(() => undefined) };
    } catch (error) {
      return {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'vmix_command_failed',
        recoverable: true
      };
    }
  }
}

function pad4(value: number): number {
  return (4 - (value % 4)) % 4;
}

function oscString(value: string): Buffer {
  const raw = Buffer.from(value + '\0', 'utf8');
  return Buffer.concat([raw, Buffer.alloc(pad4(raw.length))]);
}

function oscArgument(value: unknown): { tag: string; bytes: Buffer } {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value, 0);
    return { tag: 'i', bytes };
  }
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatBE(value, 0);
    return { tag: 'f', bytes };
  }
  if (typeof value === 'boolean') {
    return { tag: value ? 'T' : 'F', bytes: Buffer.alloc(0) };
  }
  return { tag: 's', bytes: oscString(String(value ?? '')) };
}

export function encodeOscMessage(address: string, args: unknown[] = []): Buffer {
  if (!address.startsWith('/')) throw new Error('osc_address_invalid');
  const encoded = args.map(oscArgument);
  return Buffer.concat([
    oscString(address),
    oscString(',' + encoded.map(item => item.tag).join('')),
    ...encoded.map(item => item.bytes)
  ]);
}

async function sendUdp(
  host: string,
  port: number,
  packet: Buffer
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.send(packet, port, host, error => {
      socket.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

export class OscUdpControlClient implements ProductionControlClient {
  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  async probe(): Promise<ControlProbe> {
    return {
      reachable: Boolean(this.host && Number.isInteger(this.port) && this.port > 0),
      observed: { host: this.host, port: this.port, transport: 'udp' }
    };
  }

  async invoke(action: string, payload: Record<string, unknown>): Promise<ControlInvocation> {
    const address = String(payload.address || action || '').trim();
    const args = Array.isArray(payload.args) ? payload.args : [];
    try {
      await sendUdp(this.host, this.port, encodeOscMessage(address, args));
      return {
        accepted: true,
        observed: { host: this.host, port: this.port, lastAddress: address }
      };
    } catch (error) {
      return {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'osc_send_failed',
        recoverable: true
      };
    }
  }
}

export function encodeArtDmx(input: {
  universe: number;
  sequence: number;
  channels: number[];
}): Buffer {
  const universe = Math.max(0, Math.min(0x7fff, Math.floor(input.universe)));
  const sequence = Math.max(0, Math.min(255, Math.floor(input.sequence)));
  const data = Buffer.from(
    input.channels.slice(0, 512).map(value =>
      Math.max(0, Math.min(255, Math.floor(Number(value) || 0)))
    )
  );
  const length = data.length % 2 === 0 ? data.length : data.length + 1;
  const packet = Buffer.alloc(18 + length);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet.writeUInt8(sequence, 12);
  packet.writeUInt8(0, 13);
  packet.writeUInt16LE(universe, 14);
  packet.writeUInt16BE(length, 16);
  data.copy(packet, 18);
  return packet;
}

export class ArtNetDmxControlClient implements ProductionControlClient {
  private sequence = 0;

  constructor(
    private readonly host: string,
    private readonly port = 6454,
    private readonly defaultUniverse = 0
  ) {}

  async probe(): Promise<ControlProbe> {
    return {
      reachable: Boolean(this.host && this.port > 0),
      observed: {
        host: this.host,
        port: this.port,
        transport: 'udp',
        defaultUniverse: this.defaultUniverse
      }
    };
  }

  async invoke(_action: string, payload: Record<string, unknown>): Promise<ControlInvocation> {
    const universe = Number(payload.universe ?? this.defaultUniverse);
    const channels = Array.isArray(payload.channels)
      ? payload.channels.map(value => Number(value))
      : [];
    if (!channels.length) {
      return { accepted: false, errorCode: 'artnet_channels_required', recoverable: false };
    }
    this.sequence = this.sequence >= 255 ? 1 : this.sequence + 1;
    try {
      await sendUdp(this.host, this.port, encodeArtDmx({
        universe,
        sequence: this.sequence,
        channels
      }));
      return {
        accepted: true,
        observed: {
          host: this.host,
          port: this.port,
          lastUniverse: universe,
          sequence: this.sequence
        }
      };
    } catch (error) {
      return {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'artnet_send_failed',
        recoverable: true
      };
    }
  }
}

export class HttpBridgeControlClient implements ProductionControlClient {
  constructor(private readonly baseUrl: string) {}

  async probe(): Promise<ControlProbe> {
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl.replace(/\/$/, '')}/health`,
        { method: 'GET', headers: { Accept: 'application/json' } }
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) throw new Error(`bridge_http_${response.status}`);
      return {
        reachable: true,
        version: typeof body.version === 'string' ? body.version : undefined,
        observed: body
      };
    } catch (error) {
      return {
        reachable: false,
        reason: error instanceof Error ? error.message : 'bridge_unreachable'
      };
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    const probe = await this.probe();
    if (!probe.reachable) throw new Error(probe.reason || 'bridge_unreachable');
    return probe.observed || {};
  }

  async invoke(action: string, payload: Record<string, unknown>): Promise<ControlInvocation> {
    try {
      const response = await fetchWithTimeout(
        `${this.baseUrl.replace(/\/$/, '')}/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ action, payload })
        },
        5000
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      return {
        accepted: response.ok && body.accepted !== false,
        observed:
          body.observed && typeof body.observed === 'object'
            ? body.observed as Record<string, unknown>
            : undefined,
        errorCode:
          !response.ok || body.accepted === false
            ? String(body.errorCode || `bridge_http_${response.status}`)
            : undefined,
        recoverable: response.status >= 500
      };
    } catch (error) {
      return {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'bridge_command_failed',
        recoverable: true
      };
    }
  }
}

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: any): void;
};

function sha256Base64(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

export class ObsWebSocketControlClient implements ProductionControlClient {
  private socket: WebSocketLike | null = null;
  private requestCounter = 0;

  constructor(
    private readonly url: string,
    private readonly password: string
  ) {}

  private async connect(): Promise<WebSocketLike> {
    if (this.socket && this.socket.readyState === 1) return this.socket;
    const Ctor = (globalThis as any).WebSocket;
    if (typeof Ctor !== 'function') throw new Error('obs_websocket_runtime_unavailable');

    const socket: WebSocketLike = new Ctor(this.url);
    const hello = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('obs_hello_timeout')), 3000);
      socket.addEventListener('message', (event: any) => {
        try {
          const parsed = JSON.parse(String(event.data || '{}'));
          if (parsed.op === 0) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          // Wait for a valid Hello frame.
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('obs_socket_error'));
      }, { once: true });
    });

    const auth = hello?.d?.authentication;
    let authentication: string | undefined;
    if (auth?.challenge && auth?.salt) {
      const secret = sha256Base64(this.password + String(auth.salt));
      authentication = sha256Base64(secret + String(auth.challenge));
    }

    socket.send(JSON.stringify({
      op: 1,
      d: {
        rpcVersion: 1,
        ...(authentication ? { authentication } : {})
      }
    }));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('obs_identify_timeout')), 3000);
      socket.addEventListener('message', (event: any) => {
        try {
          const parsed = JSON.parse(String(event.data || '{}'));
          if (parsed.op === 2) {
            clearTimeout(timer);
            resolve();
          }
        } catch {
          // Ignore unrelated frames.
        }
      });
    });

    this.socket = socket;
    return socket;
  }

  private async request(
    requestType: string,
    requestData: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const socket = await this.connect();
    const requestId = `ms-live-${Date.now()}-${++this.requestCounter}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('obs_request_timeout')), 5000);
      socket.addEventListener('message', (event: any) => {
        try {
          const parsed = JSON.parse(String(event.data || '{}'));
          if (parsed.op !== 7 || parsed.d?.requestId !== requestId) return;
          clearTimeout(timer);
          if (parsed.d?.requestStatus?.result !== true) {
            reject(new Error(
              String(parsed.d?.requestStatus?.comment || 'obs_request_rejected')
            ));
            return;
          }
          resolve(
            parsed.d?.responseData && typeof parsed.d.responseData === 'object'
              ? parsed.d.responseData
              : {}
          );
        } catch {
          // Ignore malformed/unrelated frames.
        }
      });

      socket.send(JSON.stringify({
        op: 6,
        d: { requestType, requestId, requestData }
      }));
    });
  }

  async probe(): Promise<ControlProbe> {
    try {
      const version = await this.request('GetVersion');
      const observed = await this.getState().catch(() => ({}));
      return {
        reachable: true,
        version: String(version.obsVersion || version.obsWebSocketVersion || ''),
        observed
      };
    } catch (error) {
      this.socket?.close();
      this.socket = null;
      return {
        reachable: false,
        reason: error instanceof Error ? error.message : 'obs_unreachable'
      };
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    const [program, preview, stream, record] = await Promise.all([
      this.request('GetCurrentProgramScene').catch((): Record<string, unknown> => ({})),
      this.request('GetCurrentPreviewScene').catch((): Record<string, unknown> => ({})),
      this.request('GetStreamStatus').catch((): Record<string, unknown> => ({})),
      this.request('GetRecordStatus').catch((): Record<string, unknown> => ({}))
    ]);
    return {
      programScene: program.currentProgramSceneName || null,
      previewScene: preview.currentPreviewSceneName || null,
      streaming: stream.outputActive === true,
      recording: record.outputActive === true
    };
  }

  async invoke(action: string, payload: Record<string, unknown>): Promise<ControlInvocation> {
    try {
      const observed = await this.request(action, payload);
      return {
        accepted: true,
        observed: Object.keys(observed).length
          ? observed
          : await this.getState().catch(() => undefined)
      };
    } catch (error) {
      return {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'obs_command_failed',
        recoverable: true
      };
    }
  }

  async dispose(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }
}
