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
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export interface AudioApiServerOptions {
  host?: string;
  port: number;
  runtime: NestLiveAudioRuntime;
  authenticate: (token: string) => boolean | Promise<boolean>;
}

export class AudioApiServer {
  private readonly server: http.Server;

  constructor(private readonly options: AudioApiServerOptions) {
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
    try {
      const auth =
        request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await this.options.authenticate(auth))) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`
      );

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
