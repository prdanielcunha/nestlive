import http from 'node:http';
import type {
  AudioCommandEnvelope,
  AudioConsoleProvider
} from '@millionsnest/nestlive-domain';
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
  response.setHeader(
    'access-control-allow-methods',
    'GET,POST,OPTIONS'
  );

  if (
    trusted &&
    request.headers['access-control-request-private-network'] === 'true'
  ) {
    response.setHeader('access-control-allow-private-network', 'true');
  }
}

export interface AudioApiServerOptions {
  host?: string;
  port: number;
  runtime: NestLiveAudioRuntime;
  authenticate: (token: string) => boolean | Promise<boolean>;
  allowedOrigins?: ReadonlySet<string>;
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

      const auth =
        request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await this.options.authenticate(auth))) {
        json(response, 401, { error: 'unauthorized' });
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
