import http from 'node:http';
import https from 'node:https';

export interface ProductionProxyConfig {
  baseUrl: string;
  token: string;
}

function normalizeLoopbackBaseUrl(input: string): URL {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('production_proxy_protocol_invalid');
  }

  if (
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    host !== '::1'
  ) {
    throw new Error('production_proxy_must_be_loopback');
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function copyResponseHeaders(
  upstream: http.IncomingMessage,
  response: http.ServerResponse
): void {
  const allowed = new Set([
    'content-type',
    'content-length',
    'cache-control',
    'etag',
    'last-modified',
    'content-disposition'
  ]);

  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    response.setHeader(name, value);
  }
}

export async function proxyToProductionEngine(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  config: ProductionProxyConfig
): Promise<void> {
  const base = normalizeLoopbackBaseUrl(config.baseUrl);
  const incoming = new URL(
    request.url ?? '/v1/production',
    'http://nestlive.local'
  );

  const prefix = '/v1/production';
  if (
    incoming.pathname !== prefix &&
    !incoming.pathname.startsWith(`${prefix}/`)
  ) {
    throw new Error('production_proxy_path_invalid');
  }

  const forwardedPath =
    incoming.pathname.slice(prefix.length) || '/';
  const target = new URL(
    `${forwardedPath}${incoming.search}`,
    `${base.toString().replace(/\/$/, '')}/`
  );

  const transport = target.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      accept: request.headers.accept ?? '*/*',
      authorization: `Bearer ${config.token}`,
      'user-agent': 'NestLive-Gateway/0.1'
    };

    if (request.headers['content-type']) {
      headers['content-type'] = request.headers['content-type'];
    }
    if (request.headers['content-length']) {
      headers['content-length'] = request.headers['content-length'];
    }
    if (request.headers['x-live-confirmation']) {
      headers['x-live-confirmation'] =
        request.headers['x-live-confirmation'];
    }

    const upstream = transport.request(
      target,
      {
        method: request.method,
        headers
      },
      upstreamResponse => {
        response.statusCode = upstreamResponse.statusCode ?? 502;
        copyResponseHeaders(upstreamResponse, response);
        upstreamResponse.on('error', reject);
        upstreamResponse.on('end', resolve);
        upstreamResponse.pipe(response);
      }
    );

    upstream.setTimeout(30_000, () => {
      upstream.destroy(new Error('production_proxy_timeout'));
    });
    upstream.on('error', reject);

    request.on('aborted', () => {
      upstream.destroy(new Error('production_proxy_client_aborted'));
    });
    request.pipe(upstream);
  });
}
