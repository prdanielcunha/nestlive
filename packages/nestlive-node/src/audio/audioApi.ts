import http from 'node:http';
import type {
  AudioCommandEnvelope,
  AudioConsoleProvider,
  NetworkInterface,
  ProviderNetworkBinding
} from '@millionsnest/nestlive-domain';
import type { PairingManager } from '../security/pairingManager';
import type { AccessTokenRecord } from '../security/accessTokenStore';
import type { GuidedNetworkPlan } from '../network/guidedPlan';
import type { NestLiveAudioRuntime } from './audioRuntime';
import type { ScaleAudioContextStore } from './scaleAudioContextStore';
import {
  fetchProductionEngineHealth,
  proxyToProductionEngine,
  type ProductionProxyConfig
} from '../production/productionProxy';
import { serveStaticWeb } from '../runtime/staticWeb';
import type { SoundcraftSpikeCoordinator } from '../soundcraft/soundcraftSpikeCoordinator';
import type { RemoteMixAuthority } from '../remote/remoteMixAuthority';
import type { RemoteMixTunnelClient } from '../remote/remoteMixTunnel';
import type { RemoteRelayConfigStore } from '../remote/remoteRelayConfigStore';

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
  authorize?: (
    token: string
  ) => AccessTokenRecord | undefined | Promise<AccessTokenRecord | undefined>;
  revokeToken?: (token: string) => boolean | Promise<boolean>;
  activePairingCount?: () => number | Promise<number>;
  pairing?: PairingManager;
  allowedOrigins?: ReadonlySet<string>;
  inspectNetwork?: () => Promise<{
    interfaces: NetworkInterface[];
    bindings?: ProviderNetworkBinding[];
    plan: GuidedNetworkPlan;
  }>;
  discoverX32?: () => Promise<X32DiscoveryResult[]>;
  connectX32?: (address: string) => Promise<{
    providerInstanceId: string;
    state: unknown;
  }>;
  localConsoleHtml?: () => Promise<string>;
  webRoot?: string;
  productionWebRoot?: string;
  productionProxy?: ProductionProxyConfig;
  soundcraftSpike?: SoundcraftSpikeCoordinator;
  soundcraftSpikeHtml?: () => string;
  scaleAudioContext?: ScaleAudioContextStore;
  remoteMixAuthority?: RemoteMixAuthority;
  remoteMixTunnel?: RemoteMixTunnelClient;
  remoteRelayConfigStore?: RemoteRelayConfigStore;
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

      const remoteAddress = request.socket.remoteAddress ?? '';
      const loopback =
        remoteAddress === '127.0.0.1' ||
        remoteAddress === '::1' ||
        remoteAddress === '::ffff:127.0.0.1';

      if (
        url.pathname.startsWith('/local/soundcraft-spike') &&
        (!this.options.soundcraftSpike || !loopback)
      ) {
        json(response, loopback ? 404 : 403, {
          error: loopback ? 'soundcraft_spike_unavailable' : 'local_only'
        });
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/local/soundcraft-spike' &&
        this.options.soundcraftSpikeHtml
      ) {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.setHeader(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        );
        response.end(this.options.soundcraftSpikeHtml());
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/local/soundcraft-spike/status' &&
        this.options.soundcraftSpike
      ) {
        json(response, 200, {
          status: this.options.soundcraftSpike.status()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/local/soundcraft-spike/start' &&
        this.options.soundcraftSpike
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          localAddress?: string;
          firmware?: string;
        };
        json(response, 201, {
          status: await this.options.soundcraftSpike.start({
            localAddress:
              String(body.localAddress ?? '').trim() || undefined,
            firmware:
              String(body.firmware ?? '').trim() || undefined
          })
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/local/soundcraft-spike/mark' &&
        this.options.soundcraftSpike
      ) {
        const body = (await readJson(request, 32 * 1024)) as {
          action?: string;
          expectedObservation?: string;
          note?: string;
        };
        const marker = this.options.soundcraftSpike.mark({
          action: String(body.action ?? ''),
          expectedObservation:
            String(body.expectedObservation ?? '').trim() || undefined,
          note: String(body.note ?? '').trim() || undefined
        });
        json(response, 201, {
          marker,
          status: this.options.soundcraftSpike.status()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/local/soundcraft-spike/stop' &&
        this.options.soundcraftSpike
      ) {
        const stopped = await this.options.soundcraftSpike.stop();
        json(response, 200, stopped);
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/local' &&
        this.options.localConsoleHtml
      ) {
        if (!loopback) {
          json(response, 404, { error: 'not_found' });
          return;
        }

        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.setHeader(
          'content-security-policy',
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'"
        );
        response.end(await this.options.localConsoleHtml());
        return;
      }

      if (
        this.options.productionWebRoot &&
        await serveStaticWeb({
          request,
          response,
          root: this.options.productionWebRoot,
          prefix: '/production',
          spaFallback: true
        })
      ) {
        return;
      }

      if (
        this.options.webRoot &&
        await serveStaticWeb({
          request,
          response,
          root: this.options.webRoot,
          prefix: '/',
          spaFallback: true
        })
      ) {
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        const productionHealth = this.options.productionProxy
          ? await fetchProductionEngineHealth(
              this.options.productionProxy
            ).catch(() => undefined)
          : undefined;
        const audioProviders = this.options.runtime.listProviders();
        const pairedDevices = this.options.activePairingCount
          ? await this.options.activePairingCount()
          : 0;

        json(response, 200, {
          ...(productionHealth ?? {}),
          product: 'NestLive Node',
          status: 'online',
          health:
            productionHealth?.health === 'degraded'
              ? 'degraded'
              : 'online',
          version:
            typeof productionHealth?.version === 'string'
              ? productionHealth.version
              : '0.1.0',
          nodeId:
            typeof productionHealth?.nodeId === 'string'
              ? productionHealth.nodeId
              : 'nestlive-node',
          hostname:
            typeof productionHealth?.hostname === 'string'
              ? productionHealth.hostname
              : 'NestLive',
          lanAddresses: Array.isArray(productionHealth?.lanAddresses)
            ? productionHealth.lanAddresses
            : [],
          providers:
            Number(productionHealth?.providers ?? 0) +
            audioProviders.length,
          providersOnline:
            Number(productionHealth?.providersOnline ?? 0) +
            audioProviders.length,
          audioProviders: audioProviders.length,
          now: new Date().toISOString(),
          pairing: {
            pairedDevices,
            pairingEnabled: Boolean(this.options.pairing)
          }
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/pairing/request' &&
        this.options.pairing
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          deviceId?: string;
          deviceName?: string;
          organizationId?: string;
          venueId?: string;
          liveSystemId?: string;
        };
        const challenge = this.options.pairing.create({
          deviceId: String(body.deviceId ?? '').trim() || undefined,
          deviceName: String(body.deviceName ?? ''),
          organizationId:
            String(body.organizationId ?? '').trim() || undefined,
          venueId: String(body.venueId ?? '').trim() || undefined,
          liveSystemId:
            String(body.liveSystemId ?? '').trim() || undefined
        });
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
          deviceId?: string;
          deviceName?: string;
        };
        const grant = await this.options.pairing.complete({
          challengeId: String(body.challengeId ?? ''),
          pin: String(body.pin ?? ''),
          deviceId: String(body.deviceId ?? '').trim() || undefined,
          deviceName:
            String(body.deviceName ?? '').trim() || undefined
        });
        json(response, 200, grant);
        return;
      }

      if (
        this.options.productionProxy &&
        url.pathname.startsWith('/local/')
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';

        if (!loopback) {
          json(response, 403, { error: 'local_only' });
          return;
        }

        await proxyToProductionEngine(request, response, {
          ...this.options.productionProxy,
          clientToken: '',
          stripPrefix: false
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/collaboration/redeem' &&
        this.options.productionProxy
      ) {
        await proxyToProductionEngine(request, response, {
          ...this.options.productionProxy,
          clientToken: '',
          stripPrefix: false
        });
        return;
      }

      const auth =
        request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
      const authorizedRecord = this.options.authorize
        ? await this.options.authorize(auth)
        : undefined;
      const gatewayAuthorized =
        Boolean(authorizedRecord) ||
        (await this.options.authenticate(auth));

      if (
        !gatewayAuthorized &&
        this.options.productionProxy &&
        auth &&
        !url.pathname.startsWith('/v1/') &&
        !url.pathname.startsWith('/local/') &&
        !url.pathname.startsWith('/pairing/')
      ) {
        await proxyToProductionEngine(request, response, {
          ...this.options.productionProxy,
          clientToken: auth,
          stripPrefix: false
        });
        return;
      }

      if (!gatewayAuthorized) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/v1/session'
      ) {
        json(response, 200, {
          tokenId: authorizedRecord?.id,
          deviceName: authorizedRecord?.deviceName,
          binding: authorizedRecord?.binding
        });
        return;
      }

            if (
        request.method === 'GET' &&
        url.pathname === '/v1/audio/scale-context' &&
        this.options.scaleAudioContext
      ) {
        json(response, 200, {
          context: await this.options.scaleAudioContext.current()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/audio/scale-context' &&
        this.options.scaleAudioContext
      ) {
        if (!authorizedRecord?.binding) {
          json(response, 403, {
            error: 'scale_audio_scoped_pairing_required'
          });
          return;
        }

        const body = (await readJson(request, 64 * 1024)) as {
          serviceId?: string;
          organizationId?: string;
          venueId?: string;
          liveSystemId?: string;
          title?: string;
          scheduledAt?: string;
          participants?: Array<{
            userId: string;
            displayName: string;
            roleName: string;
          }>;
        };

        const context = await this.options.scaleAudioContext.saveContext(
          authorizedRecord.binding,
          {
            serviceId: String(body.serviceId ?? ''),
            organizationId:
              String(body.organizationId ?? '').trim() || undefined,
            venueId:
              String(body.venueId ?? '').trim() || undefined,
            liveSystemId:
              String(body.liveSystemId ?? '').trim() || undefined,
            title: String(body.title ?? ''),
            scheduledAt: String(body.scheduledAt ?? ''),
            participants: Array.isArray(body.participants)
              ? body.participants
              : []
          }
        );
        json(response, 200, { context });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/audio/scale-context/assignments' &&
        this.options.scaleAudioContext
      ) {
        const body = (await readJson(request, 16 * 1024)) as {
          roleName?: string;
          participantUserId?: string;
          channelId?: string;
          enabled?: boolean;
        };
        const assignment =
          await this.options.scaleAudioContext.upsertAssignment({
            roleName: String(body.roleName ?? ''),
            participantUserId:
              String(body.participantUserId ?? '').trim() || undefined,
            channelId: String(body.channelId ?? ''),
            enabled: body.enabled !== false
          });
        json(response, 200, {
          assignment,
          context: await this.options.scaleAudioContext.current()
        });
        return;
      }

            if (
        request.method === 'GET' &&
        url.pathname === '/v1/remote/status' &&
        this.options.remoteMixAuthority &&
        this.options.remoteMixTunnel
      ) {
        json(response, 200, {
          tunnel: this.options.remoteMixTunnel.status(),
          grants: await this.options.remoteMixAuthority.list()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/remote/grants' &&
        this.options.remoteMixAuthority
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';
        if (!loopback) {
          json(response, 403, { error: 'remote_admin_local_only' });
          return;
        }
        if (!authorizedRecord?.binding) {
          json(response, 403, {
            error: 'remote_admin_scoped_pairing_required'
          });
          return;
        }

        const body = (await readJson(request, 24 * 1024)) as {
          actorId?: string;
          role?: 'technical_admin' | 'operator' | 'viewer';
          permissions?: Array<
            | 'audio.read'
            | 'audio.fader.write'
            | 'audio.mute.write'
            | 'audio.guarded.write'
            | 'audio.critical.write'
          >;
          ttlMinutes?: number;
        };

        const issued = await this.options.remoteMixAuthority.issue({
          organizationId: authorizedRecord.binding.organizationId,
          venueId: authorizedRecord.binding.venueId,
          liveSystemId: authorizedRecord.binding.liveSystemId,
          actorId: String(body.actorId ?? ''),
          role: body.role ?? 'viewer',
          permissions: Array.isArray(body.permissions)
            ? body.permissions
            : ['audio.read'],
          ttlMinutes: body.ttlMinutes
        });
        json(response, 201, issued);
        return;
      }

      const remoteRevokeMatch =
        /^\/v1\/remote\/grants\/([^/]+)\/revoke$/.exec(
          url.pathname
        );
      if (
        request.method === 'POST' &&
        remoteRevokeMatch &&
        this.options.remoteMixAuthority
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';
        if (!loopback) {
          json(response, 403, { error: 'remote_admin_local_only' });
          return;
        }
        json(response, 200, {
          revoked: await this.options.remoteMixAuthority.revoke(
            decodeURIComponent(remoteRevokeMatch[1]!)
          )
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/remote/relay/configure' &&
        this.options.remoteMixTunnel &&
        this.options.remoteRelayConfigStore
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';
        if (!loopback) {
          json(response, 403, { error: 'remote_admin_local_only' });
          return;
        }
        if (!authorizedRecord?.binding) {
          json(response, 403, {
            error: 'remote_admin_scoped_pairing_required'
          });
          return;
        }

        const body = (await readJson(request, 64 * 1024)) as {
          relayUrl?: string;
          nodeTicket?: string;
          scope?: {
            nodeId?: string;
            organizationId?: string;
            venueId?: string;
            liveSystemId?: string;
          };
        };
        const scope = {
          nodeId: String(body.scope?.nodeId ?? '').trim(),
          organizationId: String(
            body.scope?.organizationId ?? ''
          ).trim(),
          venueId: String(body.scope?.venueId ?? '').trim(),
          liveSystemId: String(
            body.scope?.liveSystemId ?? ''
          ).trim()
        };
        if (
          scope.nodeId !== authorizedRecord.binding.nodeId ||
          scope.organizationId !==
            authorizedRecord.binding.organizationId ||
          scope.venueId !== authorizedRecord.binding.venueId ||
          scope.liveSystemId !==
            authorizedRecord.binding.liveSystemId
        ) {
          json(response, 403, { error: 'remote_relay_scope_mismatch' });
          return;
        }

        const config = {
          relayUrl: String(body.relayUrl ?? '').trim(),
          nodeTicket: String(body.nodeTicket ?? '').trim(),
          scope
        };
        await this.options.remoteRelayConfigStore.save({
          ...config,
          configuredAt: new Date().toISOString()
        });
        await this.options.remoteMixTunnel.configure(config);
        json(response, 200, {
          tunnel: this.options.remoteMixTunnel.status()
        });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/v1/remote/relay/disable' &&
        this.options.remoteMixTunnel &&
        this.options.remoteRelayConfigStore
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';
        if (!loopback) {
          json(response, 403, { error: 'remote_admin_local_only' });
          return;
        }
        await this.options.remoteMixTunnel.disable();
        await this.options.remoteRelayConfigStore.clear();
        json(response, 200, { disabled: true });
        return;
      }

            if (
        request.method === 'POST' &&
        url.pathname === '/pairing/revoke' &&
        this.options.revokeToken
      ) {
        await this.options.revokeToken(auth);
        json(response, 200, { revoked: true });
        return;
      }

      if (
        this.options.productionProxy &&
        (url.pathname === '/v1/production' ||
          url.pathname.startsWith('/v1/production/'))
      ) {
        await proxyToProductionEngine(
          request,
          response,
          {
            ...this.options.productionProxy,
            binding: authorizedRecord?.binding
          }
        );
        return;
      }

      const stateStreamMatch =
        /^\/v1\/audio\/providers\/([^/]+)\/state\/stream$/.exec(
          url.pathname
        );
      if (request.method === 'GET' && stateStreamMatch) {
        const providerInstanceId = decodeURIComponent(
          stateStreamMatch[1]!
        );
        this.options.runtime.getProvider(providerInstanceId);

        response.statusCode = 200;
        response.setHeader(
          'content-type',
          'application/x-ndjson; charset=utf-8'
        );
        response.setHeader('cache-control', 'no-store');
        response.setHeader('connection', 'keep-alive');
        response.flushHeaders();

        const initial =
          this.options.runtime.latestStatePatch(providerInstanceId);
        if (initial) {
          response.write(
            JSON.stringify({
              type: 'audio.state.patch',
              patch: initial
            }) + '\n'
          );
        }

        const unsubscribe =
          this.options.runtime.subscribeStateEvents(
            providerInstanceId,
            patch => {
              if (response.writableEnded) return;
              if (response.writableLength > 256 * 1024) {
                response.destroy(
                  new Error('audio_state_stream_backpressure')
                );
                return;
              }
              response.write(
                JSON.stringify({
                  type: 'audio.state.patch',
                  patch
                }) + '\n'
              );
            }
          );

        request.on('close', () => {
          unsubscribe();
          if (!response.writableEnded) response.end();
        });
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

      const processingMatch =
        /^\/v1\/audio\/providers\/([^/]+)\/channels\/([^/]+)\/processing$/.exec(
          url.pathname
        );
      if (request.method === 'GET' && processingMatch) {
        const provider = this.options.runtime.getProvider(
          decodeURIComponent(processingMatch[1]!)
        );
        const channelId = decodeURIComponent(processingMatch[2]!);
        if (!provider.getChannelProcessing) {
          json(response, 404, {
            error: 'audio_channel_processing_not_supported'
          });
          return;
        }
        json(response, 200, {
          processing: await provider.getChannelProcessing(channelId)
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

      if (
        this.options.productionProxy &&
        !url.pathname.startsWith('/v1/') &&
        !url.pathname.startsWith('/pairing/')
      ) {
        const remoteAddress = request.socket.remoteAddress ?? '';
        const loopback =
          remoteAddress === '127.0.0.1' ||
          remoteAddress === '::1' ||
          remoteAddress === '::ffff:127.0.0.1';

        if (url.pathname.startsWith('/local/') && !loopback) {
          json(response, 403, { error: 'local_only' });
          return;
        }

        await proxyToProductionEngine(request, response, {
          ...this.options.productionProxy,
          binding: authorizedRecord?.binding,
          stripPrefix: false
        });
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
