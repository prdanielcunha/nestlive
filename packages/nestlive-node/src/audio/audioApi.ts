import http from 'node:http';
import type {
  AudioCommandEnvelope,
  AudioConsoleProvider,
  NetworkInterface
} from '@millionsnest/nestlive-domain';
import type { PairingManager } from '../security/pairingManager';
import type { GuidedNetworkPlan } from '../network/guidedPlan';
import type { NestLiveAudioRuntime } from './audioRuntime';

function json(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readJson(
  request: http.IncomingMessage,
  maxBytes = 256 * 1024
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error('payload_too_large');
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function isTrustedNestLiveOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();

    if (
      url.protocol === 'https:' &&
      (host === 'millionsnest.com' || host.endsWith('.millionsnest.com'))
    ) {
      return true;
    }

    if (
      url.protocol === 'http:' &&
      (host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1')
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function applyCors(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: ReadonlySet<string>
): void {
  const origin = request.headers.origin;
  const trusted =
    Boolean(origin) &&
    (allowedOrigins.has(origin!) || isTrustedNestLiveOrigin(origin!));

  if (trusted && origin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }

  response.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,x-nestlive-confirmation'
  );
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');

  if (
    trusted &&
    request.headers['access-control-request-private-network'] === 'true'
  ) {
    response.setHeader('access-control-allow-private-network', 'true');
  }
}

export interface X32DiscoveryResult {
  address: string;
  networkName?: string;
  model?: string;
  firmware?: string;
  latencyMs: number;
}

export interface AudioApiServerOptions {
  host?: string;
  port: number;
  runtime: NestLiveAudioRuntime;
  authenticate: (token: string) => boolean | Promise<boolean>;
  pairing?: PairingManager;
  allowedOrigins?: ReadonlySet<string>;
  inspectNetwork?: () => Promise<{
    interfaces: NetworkInterface[];
    plan: GuidedNetworkPlan;
  }>;
  discoverX32?: () => Promise<X32DiscoveryResult[]>;
  connectX32?: (address: string) => Promise<{
    providerInstanceId: string;
    state: unknown;
  }>;
}

export class AudioApiServer {
  private readonly server: http.Server;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(private readonly options: AudioApiServerOptions) {
    this.allowedOrigins = options.allowedOrigins ?? new Set();
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(
        this.options.port,
        this.options.host ?? '0.0.0.0',
        () => resolve()
      );
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => (error ? reject(error) : resolve()));
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    applyCors(request, response, this.allowedOrigins);

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    try {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`
      );

      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, {
          product: 'NestLive Node',
          status: 'online',
          now: new Date().toISOString()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/pairing/request' &&
        this.options.pairing
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          deviceName?: string;
        };
        const challenge = this.options.pairing.create(
          String(body.deviceName ?? '')
        );
        json(response, 201, challenge);
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/pairing/complete' &&
        this.options.pairing
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          challengeId?: string;
          pin?: string;
        };
        const grant = await this.options.pairing.complete({
          challengeId: String(body.challengeId ?? ''),
          pin: String(body.pin ?? '')
        });
        json(response, 200, grant);
        return;
      }

      const auth =
        request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await this.options.authenticate(auth))) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      const meterStreamMatch =
        /^\/v1\/audio\/providers\/([^/]+)\/meters\/stream$/.exec(
          url.pathname
        );
      if (request.method === 'GET' && meterStreamMatch) {
        const providerInstanceId = decodeURIComponent(meterStreamMatch[1]!);
        this.options.runtime.getProvider(providerInstanceId);

        response.statusCode = 200;
        response.setHeader(
          'content-type',
          'application/x-ndjson; charset=utf-8'
        );
        response.setHeader('cache-control', 'no-store');
        response.setHeader('connection', 'keep-alive');
        response.flushHeaders();

        let lastSequence = -1;
        const timer = setInterval(() => {
          const frame = this.options.runtime.latestMeter(providerInstanceId);
          if (!frame || frame.sequence === lastSequence) return;
          lastSequence = frame.sequence;

          if (response.writableLength > 256 * 1024) return;
          response.write(
            JSON.stringify({ type: 'meter.frame', frame }) + '\n'
          );
        }, 33);

        request.on('close', () => {
          clearInterval(timer);
          if (!response.writableEnded) response.end();
        });
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/v1/network/plan' &&
        this.options.inspectNetwork
      ) {
        json(response, 200, await this.options.inspectNetwork());
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/audio/discover/x32' &&
        this.options.discoverX32
      ) {
        json(response, 200, {
          consoles: await this.options.discoverX32()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/audio/connect/x32' &&
        this.options.connectX32
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          address?: string;
        };
        const address = String(body.address ?? '').trim();
        if (!address) throw new Error('x32_address_required');
        json(response, 200, await this.options.connectX32(address));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/audio/providers') {
        json(response, 200, {
          providers: this.options.runtime.listProviders()
        });
        return;
      }

      const channelMatch = /^\/v1\/audio\/providers\/([^/]+)\/channels$/.exec(
        url.pathname
      );
      if (request.method === 'GET' && channelMatch) {
        const provider = this.options.runtime.getProvider(
          decodeURIComponent(channelMatch[1]!)
        );
        json(response, 200, {
          channels: await provider.getChannels()
        });
        return;
      }

      const healthMatch = /^\/v1\/audio\/providers\/([^/]+)\/state$/.exec(
        url.pathname
      );
      if (request.method === 'GET' && healthMatch) {
        const provider: AudioConsoleProvider =
          this.options.runtime.getProvider(
            decodeURIComponent(healthMatch[1]!)
          );
        json(response, 200, {
          state: await provider.getConsoleState()
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/audio/commands') {
        const envelope = (await readJson(request)) as AudioCommandEnvelope;
        const execution = await this.options.runtime.execute(envelope);
        json(response, 200, execution);
        return;
      }

      json(response, 404, { error: 'not_found' });
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  }
}
