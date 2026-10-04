import http from 'node:http';
import https from 'node:https';

export interface ProductionProxyBinding {
  nodeId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  deviceId: string;
  deviceName: string;
}

export interface ProductionProxyConfig {
  baseUrl: string;
  token: string;
  clientToken?: string;
  binding?: ProductionProxyBinding;
  stripPrefix?: boolean;
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
  const shouldStrip = config.stripPrefix !== false;
  if (
    shouldStrip &&
    incoming.pathname !== prefix &&
    !incoming.pathname.startsWith(`${prefix}/`)
  ) {
    throw new Error('production_proxy_path_invalid');
  }

  const forwardedPath = shouldStrip
    ? incoming.pathname.slice(prefix.length) || '/'
    : incoming.pathname;
  const target = new URL(
    `${forwardedPath}${incoming.search}`,
    `${base.toString().replace(/\/$/, '')}/`
  );

  const transport = target.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {
      accept: request.headers.accept ?? '*/*',
      authorization: `Bearer ${config.clientToken || config.token}`,
      'user-agent': 'NestLive-Gateway/0.1'
    };

    if (!config.clientToken && config.binding) {
      headers['x-nestlive-node-id'] = config.binding.nodeId;
      headers['x-nestlive-organization-id'] = config.binding.organizationId;
      headers['x-nestlive-venue-id'] = config.binding.venueId;
      headers['x-nestlive-system-id'] = config.binding.liveSystemId;
      headers['x-nestlive-device-id'] = config.binding.deviceId;
      headers['x-nestlive-device-name'] = encodeURIComponent(
        config.binding.deviceName
      );
    }

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


export async function fetchProductionEngineHealth(
  config: Pick<ProductionProxyConfig, 'baseUrl'>
): Promise<Record<string, unknown>> {
  const base = normalizeLoopbackBaseUrl(config.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(new URL('/health', base), {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`production_health_http_${response.status}`);
    }
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}
