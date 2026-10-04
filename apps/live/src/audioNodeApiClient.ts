import type {
  AudioChannel,
  AudioCommandEnvelope,
  AudioCommandExecution,
  AudioControlCommand,
  AudioSafetyLevel
} from '@millionsnest/nestlive-domain';

export interface AudioProviderSummary {
  providerInstanceId: string;
  capabilities: string[];
}

export interface NestLiveNodeConnection {
  httpBaseUrl: string;
  wsUrl: string;
  token: string;
  providerInstanceId?: string;
}

function ipv4IsPrivate(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
  );
}

export function normalizePrivateNodeUrl(input: string): string {
  const value = input.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const local =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    ipv4IsPrivate(host);

  if (!local) throw new Error('node_must_be_local');
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('unsupported_node_protocol');
  }

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function targetAddressSpace(
  url: URL
): 'local' | 'loopback' {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.')
    ? 'loopback'
    : 'local';
}

export class NestLiveAudioApiClient {
  private readonly httpBaseUrl: string;

  constructor(private readonly connection: NestLiveNodeConnection) {
    this.httpBaseUrl = normalizePrivateNodeUrl(connection.httpBaseUrl);
  }

  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const url = new URL(path, this.httpBaseUrl);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    try {
      const networkInit = {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        targetAddressSpace: targetAddressSpace(url),
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        }
      } as RequestInit & {
        targetAddressSpace?: 'local' | 'loopback';
      };

      const response = await fetch(url, networkInit);
      const body = (await response.json().catch(() => ({}))) as T & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error ?? `node_http_${response.status}`);
      }
      return body;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('node_timeout');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async health(): Promise<{
    product: string;
    status: string;
    now: string;
  }> {
    const url = new URL('/health', this.httpBaseUrl);
    const response = await fetch(url, {
      cache: 'no-store',
      targetAddressSpace: targetAddressSpace(url)
    } as RequestInit & {
      targetAddressSpace?: 'local' | 'loopback';
    });

    if (!response.ok) throw new Error('node_unreachable');
    return response.json();
  }

  async providers(): Promise<AudioProviderSummary[]> {
    const body = await this.request<{ providers: AudioProviderSummary[] }>(
      '/v1/audio/providers'
    );
    return body.providers;
  }

  async channels(providerInstanceId: string): Promise<AudioChannel[]> {
    const body = await this.request<{ channels: AudioChannel[] }>(
      `/v1/audio/providers/${encodeURIComponent(providerInstanceId)}/channels`
    );
    return body.channels;
  }

  async execute(input: {
    providerInstanceId: string;
    actorId: string;
    command: AudioControlCommand;
    confirmedSafetyLevel?: AudioSafetyLevel;
  }): Promise<AudioCommandExecution> {
    const envelope: AudioCommandEnvelope = {
      id: crypto.randomUUID(),
      actorId: input.actorId,
      providerInstanceId: input.providerInstanceId,
      createdAt: new Date().toISOString(),
      command: input.command,
      confirmedSafetyLevel: input.confirmedSafetyLevel
    };

    return this.request<AudioCommandExecution>(
      '/v1/audio/commands',
      {
        method: 'POST',
        body: JSON.stringify(envelope)
      }
    );
  }
}
