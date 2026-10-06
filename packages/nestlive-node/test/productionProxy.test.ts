import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { proxyToProductionEngine } from '../src';

async function listen(
  handler: http.RequestListener
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server_address_missing');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

describe('production gateway proxy', () => {
  it('strips the public prefix and injects the internal bearer', async () => {
    const upstream = await listen((request, response) => {
      expect(request.url).toBe('/providers?full=1');
      expect(request.headers.authorization).toBe('Bearer internal-secret');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });

    const gateway = await listen((request, response) => {
      void proxyToProductionEngine(request, response, {
        baseUrl: upstream.url,
        token: 'internal-secret'
      });
    });

    try {
      const response = await fetch(
        `${gateway.url}/v1/production/providers?full=1`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await new Promise<void>(resolve => gateway.server.close(() => resolve()));
      await new Promise<void>(resolve => upstream.server.close(() => resolve()));
    }
  });

  it('rejects non-loopback upstreams', async () => {
    const request = new http.IncomingMessage(null as never);
    const response = new http.ServerResponse(request);
    await expect(
      proxyToProductionEngine(request, response, {
        baseUrl: 'https://example.com',
        token: 'secret'
      })
    ).rejects.toThrow('production_proxy_must_be_loopback');
  });
});
