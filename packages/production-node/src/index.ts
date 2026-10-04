import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import {
  CAPABILITIES,
  CapabilityEngine,
  transitionLiveRequest,
  evaluateFailoverCandidate,
  failoverIdempotencyKey,
  routeGroupForCapability,
  type Capability,
  type CommandResult,
  type LiveCommand,
  type LiveChatMessage,
  type LiveDropAsset,
  type LiveRequest,
  type LiveRequestStatus,
  type LiveCollaborationRole,
  type PairingRequest,
  type ProviderAssetRequest,
  type ProviderLink,
  type ProviderRouteGroup,
  type Scene,
  type SceneExecutionRequest,
  type SceneExecutionResult,
  type ServicePlan
} from '@millionsnest/nestlive-production-domain';
import { IdempotencyStore } from './idempotencyStore';
import { PairingStore } from './pairingStore';
import { CollaborationInviteStore } from './collaborationInviteStore';
import { RuntimeStateStore } from './runtimeStateStore';
import { ProviderConfigStore } from './providerConfigStore';
import { createPlatformSecretProtector } from './secretProtector';
import { ProviderRoutingStore } from './providerRoutingStore';
import { PeerNodeStore } from './peerNodeStore';
import { PeerFederation } from './peerFederation';
import { SignalTopologyStore } from './signalTopologyStore';
import {
  LiveDropStore,
  type LiveDropRetentionPreset,
  type LiveDropScope
} from './liveDropStore';
import { stageAndOpenPeerLiveDrop } from './liveDropFederation';
import { buildLiveNodeDiagnostics } from './diagnostics';
import { buildCertificationReport } from './certificationReport';
import { NodeProfileStore } from './nodeProfileStore';
import { isTrustedLiveWebOrigin } from './networkPolicy';
import { SceneExecutor } from './sceneExecutor';
import { PeerDiscovery } from './peerDiscovery';
import { sanitizeObservedStateForPersistence } from './observedStateSanitizer';
import { LiveEventLogStore } from './liveEventLogStore';
import { LiveChatStore } from './liveChatStore';
import {
  eventFromCommand,
  eventFromRequestCreated,
  eventFromRequestStatus,
  eventFromScene
} from './liveEventFactory';
import { HolyricsAdapter, HolyricsHttpClient } from '@millionsnest/nestlive-adapter-holyrics';
import {
  ResolumeAdapter,
  ResolumeRealtimeClient,
  ResolumeRestClient
} from '@millionsnest/nestlive-adapter-resolume';
import {
  ProPresenterAdapter,
  ProPresenterHttpClient
} from '@millionsnest/nestlive-adapter-propresenter';
import {
  ArtNetDmxControlClient,
  HttpBridgeControlClient,
  ObsWebSocketControlClient,
  OscUdpControlClient,
  PRODUCTION_ADAPTER_MANIFESTS,
  ProductionControlAdapter,
  VmixHttpControlClient
} from '@millionsnest/nestlive-adapters-production';
import { ProductionProviderConfigStore } from './productionProviderConfigStore';
import { ProductionWorkspaceStore } from './productionWorkspaceStore';
import {
  createLiveNodeBackup,
  validateLiveNodeBackup
} from './nodeBackup';
import { toString as qrToString } from 'qrcode';

function liveEnv(name: string): string | undefined {
  return (
    process.env[`NESTLIVE_${name}`] ??
    process.env[`MUSICSCALE_LIVE_${name}`] ??
    process.env[`MILLIONSNEST_LIVE_${name}`]
  );
}

// The public/local NestLive gateway owns 4317. The production engine stays
// loopback-only by default and is reached through the authenticated gateway.
const PORT = Number(liveEnv('NODE_PORT') || 4337);
const HOST = liveEnv('NODE_HOST') || '127.0.0.1';
const VERSION = '0.1.0';
const DEV_TOKEN = liveEnv('DEV_TOKEN') || '';
const PAIRING_ENABLED = liveEnv('PAIRING_ENABLED') !== 'false';
const HOLYRICS_TOKEN = liveEnv('HOLYRICS_TOKEN')?.trim() || '';
const HOLYRICS_URL = liveEnv('HOLYRICS_URL')?.trim() || 'http://127.0.0.1:8091';
const DEFAULT_RESOLUME_URL = 'http://127.0.0.1:8080';
const RESOLUME_URL = liveEnv('RESOLUME_URL')?.trim() || '';
const DEFAULT_PROPRESENTER_URL = '';
const PROPRESENTER_URL = liveEnv('PROPRESENTER_URL')?.trim() || '';
const LIVE_DROP_MAX_BYTES_ENV = Number(liveEnv('LIVE_DROP_MAX_BYTES') || '');
const LIVE_DROP_MAX_BYTES =
  Number.isFinite(LIVE_DROP_MAX_BYTES_ENV) && LIVE_DROP_MAX_BYTES_ENV > 0
    ? Math.floor(LIVE_DROP_MAX_BYTES_ENV)
    : 250 * 1024 * 1024;

function liveDropHours(name: string, fallback: number | null): number | null {
  const raw = liveEnv(name)?.trim();
  if (!raw) return fallback;
  const hours = Number(raw);
  if (!Number.isFinite(hours)) return fallback;
  if (hours <= 0) return null;
  return hours;
}

const LIVE_DROP_QUARANTINE_HOURS =
  liveDropHours('LIVE_DROP_QUARANTINE_HOURS', 24) ?? 24;
const LIVE_DROP_REJECTED_HOURS =
  liveDropHours('LIVE_DROP_REJECTED_HOURS', 1) ?? 1;
const LIVE_DROP_READY_HOURS =
  liveDropHours('LIVE_DROP_READY_HOURS', null);
const MODERN_STATE_DIR = join(homedir(), '.nestlive');
const LEGACY_STATE_DIR = join(homedir(), '.millionsnest-live');
const STATE_DIR =
  liveEnv('STATE_DIR') ||
  (existsSync(MODERN_STATE_DIR) || !existsSync(LEGACY_STATE_DIR)
    ? MODERN_STATE_DIR
    : LEGACY_STATE_DIR);
const PACKAGED_WEB_ROOT = resolve(dirname(process.execPath), 'web');
const WORKSPACE_WEB_ROOT = resolve(process.cwd(), 'apps/live/dist');
const PACKAGE_CWD_WEB_ROOT = resolve(process.cwd(), '../../apps/live/dist');
const DEFAULT_WEB_ROOT = [
  PACKAGED_WEB_ROOT,
  WORKSPACE_WEB_ROOT,
  PACKAGE_CWD_WEB_ROOT
].find(candidate => existsSync(join(candidate, 'index.html'))) || PACKAGED_WEB_ROOT;
const WEB_ROOT = resolve(liveEnv('WEB_ROOT') || DEFAULT_WEB_ROOT);

const allowedOrigins = new Set(
  (liveEnv('ALLOWED_ORIGINS') || 'http://localhost:4316,http://127.0.0.1:4316')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const nodeId = liveEnv('NODE_ID') ||
  `node_${createHash('sha256').update(`${hostname()}|nestlive`).digest('hex').slice(0, 16)}`;

const capabilityEngine = new CapabilityEngine();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 5000;
const idempotency = new IdempotencyStore<CommandResult[]>(
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX_ENTRIES,
  join(STATE_DIR, 'idempotency-commands.json')
);
const sceneIdempotency = new IdempotencyStore<SceneExecutionResult>(
  IDEMPOTENCY_TTL_MS,
  IDEMPOTENCY_MAX_ENTRIES,
  join(STATE_DIR, 'idempotency-scenes.json')
);
const pairingStore = new PairingStore(join(STATE_DIR, 'pairings.json'), nodeId);
const collaborationInviteStore = new CollaborationInviteStore(
  join(STATE_DIR, 'collaboration.json'),
  nodeId
);
const runtimeState = new RuntimeStateStore(join(STATE_DIR, 'runtime.json'), nodeId);
const secretProtector = createPlatformSecretProtector();
const providerConfigStore = new ProviderConfigStore(
  join(STATE_DIR, 'providers.json'),
  secretProtector
);
const productionProviderConfigStore = new ProductionProviderConfigStore(
  join(STATE_DIR, 'production-providers.json'),
  secretProtector
);
const productionWorkspaceStore = new ProductionWorkspaceStore(
  join(STATE_DIR, 'production-workspace.json')
);
const registeredProductionProviderIds = new Set<string>();
const providerRoutingStore = new ProviderRoutingStore(join(STATE_DIR, 'routing.json'));
const peerNodeStore = new PeerNodeStore(join(STATE_DIR, 'peers.json'));
const signalTopologyStore = new SignalTopologyStore(join(STATE_DIR, 'signal-topology.json'));
const eventLogStore = new LiveEventLogStore(join(STATE_DIR, 'events.json'));
const liveChatStore = new LiveChatStore(join(STATE_DIR, 'chat.json'));
const nodeProfileStore = new NodeProfileStore(join(STATE_DIR, 'profile.json'), hostname());
let nodeDisplayName = hostname();
const liveDropStore = new LiveDropStore(
  join(STATE_DIR, 'live-drop'),
  undefined,
  LIVE_DROP_MAX_BYTES,
  {
    quarantineTtlMs: LIVE_DROP_QUARANTINE_HOURS * 60 * 60 * 1000,
    rejectedTtlMs: LIVE_DROP_REJECTED_HOURS * 60 * 60 * 1000,
    readyTtlMs: LIVE_DROP_READY_HOURS === null
      ? null
      : LIVE_DROP_READY_HOURS * 60 * 60 * 1000
  }
);
const peerFederation = new PeerFederation({
  localNodeId: nodeId,
  localDisplayName: nodeDisplayName,
  capabilityEngine,
  store: peerNodeStore
});
const peerDiscovery = new PeerDiscovery({
  nodeId,
  displayName: nodeDisplayName,
  httpPort: PORT,
  version: VERSION
});

const pairingRequestHits = new Map<string, number>();

async function registerHolyricsProvider(): Promise<{
  configured: boolean;
  source: 'environment' | 'local' | 'none';
  probe?: Awaited<ReturnType<HolyricsAdapter['probe']>>;
  baseUrl?: string;
}> {
  capabilityEngine.unregister('holyrics-primary');

  const localConfig = await providerConfigStore.getHolyrics();
  const token = HOLYRICS_TOKEN || localConfig?.token || '';
  const baseUrl = HOLYRICS_TOKEN
    ? HOLYRICS_URL
    : localConfig?.baseUrl || HOLYRICS_URL;
  const source = HOLYRICS_TOKEN
    ? 'environment' as const
    : localConfig
      ? 'local' as const
      : 'none' as const;

  if (!token) {
    console.log(JSON.stringify({
      event: 'provider_not_configured',
      providerKey: 'holyrics'
    }));
    return { configured: false, source };
  }

  const adapter = new HolyricsAdapter({
    id: 'holyrics-primary',
    nodeId,
    displayName: 'Holyrics',
    api: new HolyricsHttpClient({
      baseUrl,
      token
    })
  });

  capabilityEngine.register(adapter);
  const probe = await adapter.probe();

  console.log(JSON.stringify({
    event: 'provider_probe',
    providerKey: 'holyrics',
    providerId: adapter.descriptor.id,
    reachable: probe.reachable,
    version: probe.version || null,
    capabilities: probe.capabilities,
    reason: probe.reason || null,
    configurationSource: source
  }));

  return {
    configured: true,
    source,
    probe,
    baseUrl
  };
}


async function registerResolumeProvider(): Promise<{
  configured: boolean;
  source: 'environment' | 'local' | 'detected' | 'none';
  probe?: Awaited<ReturnType<ResolumeAdapter['probe']>>;
  baseUrl?: string;
}> {
  capabilityEngine.unregister('resolume-primary');

  const localConfig = await providerConfigStore.getResolume();
  const explicitBaseUrl = RESOLUME_URL || localConfig?.baseUrl || '';
  const autoDetect = !explicitBaseUrl;
  const baseUrl = explicitBaseUrl || DEFAULT_RESOLUME_URL;
  const source = RESOLUME_URL
    ? 'environment' as const
    : localConfig
      ? 'local' as const
      : 'detected' as const;

  const adapter = new ResolumeAdapter({
    id: 'resolume-primary',
    nodeId,
    displayName: 'Resolume Arena',
    api: new ResolumeRestClient({ baseUrl }),
    realtime: new ResolumeRealtimeClient({ baseUrl })
  });

  capabilityEngine.register(adapter);
  const probe = await adapter.probe();

  if (autoDetect && !probe.reachable) {
    capabilityEngine.unregister('resolume-primary');
    console.log(JSON.stringify({
      event: 'provider_not_detected',
      providerKey: 'resolume',
      candidate: baseUrl
    }));
    return {
      configured: false,
      source: 'none',
      probe,
      baseUrl
    };
  }

  console.log(JSON.stringify({
    event: autoDetect ? 'provider_auto_detected' : 'provider_probe',
    providerKey: 'resolume',
    providerId: adapter.descriptor.id,
    reachable: probe.reachable,
    version: probe.version || null,
    capabilities: probe.capabilities,
    reason: probe.reason || null,
    configurationSource: source
  }));

  return {
    configured: true,
    source,
    probe,
    baseUrl
  };
}


async function registerProPresenterProvider(): Promise<{
  configured: boolean;
  source: 'environment' | 'local' | 'none';
  probe?: Awaited<ReturnType<ProPresenterAdapter['probe']>>;
  baseUrl?: string;
}> {
  capabilityEngine.unregister('propresenter-primary');

  const localConfig = await providerConfigStore.getProPresenter();
  const baseUrl = PROPRESENTER_URL || localConfig?.baseUrl || '';
  const source = PROPRESENTER_URL
    ? 'environment' as const
    : localConfig
      ? 'local' as const
      : 'none' as const;

  if (!baseUrl) {
    console.log(JSON.stringify({
      event: 'provider_not_configured',
      providerKey: 'propresenter'
    }));
    return { configured: false, source };
  }

  const adapter = new ProPresenterAdapter({
    id: 'propresenter-primary',
    nodeId,
    displayName: 'ProPresenter',
    api: new ProPresenterHttpClient({ baseUrl })
  });

  capabilityEngine.register(adapter);
  const probe = await adapter.probe();

  console.log(JSON.stringify({
    event: 'provider_probe',
    providerKey: 'propresenter',
    providerId: adapter.descriptor.id,
    reachable: probe.reachable,
    version: probe.version || null,
    capabilities: probe.capabilities,
    reason: probe.reason || null,
    configurationSource: source
  }));

  return {
    configured: true,
    source,
    probe,
    baseUrl
  };
}

function productionManifestByKey(adapterKey: string) {
  return Object.values(PRODUCTION_ADAPTER_MANIFESTS)
    .find(manifest => manifest.adapterKey === adapterKey);
}

function productionControlClient(config: {
  adapterKey: string;
  config: Record<string, unknown>;
}) {
  const value = config.config;
  switch (config.adapterKey) {
    case 'obs-websocket':
      return new ObsWebSocketControlClient(
        String(value.url || ''),
        String(value.password || '')
      );
    case 'vmix':
      return new VmixHttpControlClient(String(value.baseUrl || ''));
    case 'osc':
      return new OscUdpControlClient(
        String(value.host || ''),
        Number(value.port || 8000)
      );
    case 'artnet-dmx':
      return new ArtNetDmxControlClient(
        String(value.host || ''),
        Number(value.port || 6454),
        Number(value.universe || 0)
      );
    case 'companion':
    case 'midi':
    case 'atem':
      return new HttpBridgeControlClient(String(value.baseUrl || ''));
    default:
      throw new Error('production_adapter_unsupported');
  }
}

async function registerProductionProviders(): Promise<Array<{
  instanceId: string;
  adapterKey: string;
  reachable: boolean;
  version?: string;
  capabilities: Capability[];
  reason?: string;
}>> {
  for (const providerId of registeredProductionProviderIds) {
    const adapter = capabilityEngine.get(providerId);
    await adapter?.dispose?.().catch(() => undefined);
    capabilityEngine.unregister(providerId);
  }
  registeredProductionProviderIds.clear();

  const configs = await productionProviderConfigStore
    .allResolved(PRODUCTION_ADAPTER_MANIFESTS);
  const results: Array<{
    instanceId: string;
    adapterKey: string;
    reachable: boolean;
    version?: string;
    capabilities: Capability[];
    reason?: string;
  }> = [];

  for (const config of configs) {
    const manifest = productionManifestByKey(config.adapterKey);
    if (!manifest) continue;

    const adapter = new ProductionControlAdapter({
      id: config.instanceId,
      nodeId,
      displayName: config.displayName,
      manifest,
      client: productionControlClient(config)
    });
    capabilityEngine.register(adapter);
    registeredProductionProviderIds.add(config.instanceId);

    const probe = await adapter.probe();
    results.push({
      instanceId: config.instanceId,
      adapterKey: config.adapterKey,
      reachable: probe.reachable,
      version: probe.version,
      capabilities: probe.capabilities,
      reason: probe.reason
    });

    console.log(JSON.stringify({
      event: 'production_provider_probe',
      providerId: config.instanceId,
      providerKey: config.adapterKey,
      reachable: probe.reachable,
      version: probe.version || null,
      capabilities: probe.capabilities,
      reason: probe.reason || null
    }));
  }

  return results;
}

const providerObservationInFlight = new Set<string>();
const providerLastObservedAt = new Map<string, number>();

function observeOnlineProviders(): void {
  const now = Date.now();
  const online = capabilityEngine
    .quickSnapshot()
    .filter(provider => provider.health === 'online');

  for (const snapshot of online) {
    const provider = capabilityEngine.get(snapshot.providerId);
    if (!provider || providerObservationInFlight.has(snapshot.providerId)) continue;

    const cadence = Math.max(200, provider.observationIntervalMs ?? 1200);
    const lastObservedAt = providerLastObservedAt.get(snapshot.providerId) || 0;
    if (now - lastObservedAt < cadence) continue;

    providerObservationInFlight.add(snapshot.providerId);
    providerLastObservedAt.set(snapshot.providerId, now);

    void provider.getState()
      .then(async state => {
        const observed = sanitizeObservedStateForPersistence(state.observed || {});
        await runtimeState.mergeProviderObservedState(
          snapshot.providerId,
          observed
        );
      })
      .catch(() => {
        // Provider adapters own their degraded/offline transition semantics.
      })
      .finally(() => {
        providerObservationInFlight.delete(snapshot.providerId);
      });
  }
}

async function recoverUnhealthyProviders(): Promise<void> {
  if (!capabilityEngine.get('resolume-primary')) {
    const configuredResolume = RESOLUME_URL || (await providerConfigStore.getResolume())?.baseUrl;
    if (!configuredResolume) {
      await registerResolumeProvider();
    }
  }

  const unhealthy = capabilityEngine
    .quickSnapshot()
    .filter(provider => provider.health !== 'online');

  for (const snapshot of unhealthy) {
    const provider = capabilityEngine.get(snapshot.providerId);
    if (!provider) continue;
    try {
      const probe = await provider.probe();
      if (probe.reachable) {
        console.log(JSON.stringify({
          event: 'provider_recovered',
          providerId: snapshot.providerId,
          capabilities: probe.capabilities
        }));
      }
    } catch (error) {
      console.log(JSON.stringify({
        event: 'provider_recovery_waiting',
        providerId: snapshot.providerId,
        error: error instanceof Error ? error.message : 'unknown'
      }));
    }
  }
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const group of Object.values(networkInterfaces())) {
    for (const entry of group || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isTrustedLiveWebOrigin(origin, allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,x-correlation-id,x-live-confirmation,x-live-file-name,x-live-actor-id'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendBinary(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Uint8Array,
  cacheControl = 'no-store'
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  res.end(Buffer.from(body));
}

function sendSvg(res: ServerResponse, status: number, svg: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(svg);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"
  );
  res.end(html);
}

async function readJsonWithLimit(
  req: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('payload_too_large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return readJsonWithLimit(req, 256 * 1024);
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress || '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || 'unknown';
}

function pairingRateLimited(req: IncomingMessage): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const previous = pairingRequestHits.get(ip) || 0;
  if (now - previous < 2_000) return true;
  pairingRequestHits.set(ip, now);
  if (pairingRequestHits.size > 200) {
    for (const [key, timestamp] of pairingRequestHits) {
      if (now - timestamp > 10 * 60_000) pairingRequestHits.delete(key);
    }
  }
  return false;
}

function requireStrings(
  value: Record<string, unknown>,
  fields: string[],
  code = 'invalid_request'
): void {
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !String(value[field]).trim()) {
      throw new Error(code);
    }
  }
}

function validatePairingRequest(value: unknown): PairingRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid_pairing_request');
  const candidate = value as Record<string, unknown>;
  requireStrings(
    candidate,
    ['deviceId', 'deviceName'],
    'invalid_pairing_request'
  );

  const scopeValues = [
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSystemId
  ];
  const scopeCount = scopeValues.filter(
    value => typeof value === 'string' && String(value).trim()
  ).length;

  if (scopeCount !== 0 && scopeCount !== 3) {
    throw new Error('invalid_pairing_scope');
  }

  return {
    organizationId: scopeCount === 3 ? String(candidate.organizationId) : undefined,
    venueId: scopeCount === 3 ? String(candidate.venueId) : undefined,
    liveSystemId: scopeCount === 3 ? String(candidate.liveSystemId) : undefined,
    deviceId: String(candidate.deviceId),
    deviceName: String(candidate.deviceName)
  };
}

function validateServicePlan(value: unknown): ServicePlan {
  if (!value || typeof value !== 'object') throw new Error('invalid_service_plan');
  const candidate = value as Partial<ServicePlan>;
  const requiredStrings = [
    candidate.id,
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSystemId,
    candidate.title,
    candidate.scheduledAt
  ];
  if (requiredStrings.some(item => typeof item !== 'string' || !item)) {
    throw new Error('invalid_service_plan');
  }
  if (!Array.isArray(candidate.items)) throw new Error('invalid_service_plan');
  if (!Number.isInteger(candidate.revision) || Number(candidate.revision) < 1) {
    throw new Error('invalid_service_plan_revision');
  }
  return candidate as ServicePlan;
}

function validateProviderLinks(value: unknown): ProviderLink[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('invalid_provider_links');

  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('invalid_provider_link');
    const link = item as Partial<ProviderLink>;
    const requiredStrings = [
      link.id,
      link.organizationId,
      link.venueId,
      link.providerInstanceId,
      link.entityType,
      link.externalId
    ];
    if (requiredStrings.some(field => typeof field !== 'string' || !field)) {
      throw new Error('invalid_provider_link');
    }
    if (!capabilityEngine.get(String(link.providerInstanceId))) {
      throw new Error('provider_link_target_missing');
    }
    return link as ProviderLink;
  });
}

function assertProviderLinksScope(
  links: ProviderLink[],
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  for (const link of links) {
    if (
      link.organizationId !== binding.organizationId ||
      link.venueId !== binding.venueId
    ) {
      throw new Error('forbidden_scope');
    }
  }
}

function assertServicePlanScope(
  plan: ServicePlan,
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  if (
    plan.organizationId !== binding.organizationId ||
    plan.venueId !== binding.venueId ||
    plan.liveSystemId !== binding.liveSystemId
  ) {
    throw new Error('forbidden_scope');
  }
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

function validateSceneExecutionRequest(value: unknown): SceneExecutionRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid_scene_execution');
  const candidate = value as Partial<SceneExecutionRequest>;
  const requiredStrings = [
    candidate.id,
    candidate.correlationId,
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSystemId,
    candidate.liveSessionId,
    candidate.actorId,
    candidate.idempotencyKey
  ];
  if (requiredStrings.some(item => typeof item !== 'string' || !item)) {
    throw new Error('invalid_scene_execution');
  }
  if (!['live-ui','pastor','conductor','automation','api'].includes(String(candidate.origin))) {
    throw new Error('invalid_origin');
  }

  const scene = candidate.scene;
  if (!scene || typeof scene !== 'object') throw new Error('invalid_scene');
  if (
    typeof scene.id !== 'string' ||
    !scene.id ||
    typeof scene.organizationId !== 'string' ||
    typeof scene.venueId !== 'string' ||
    typeof scene.name !== 'string' ||
    !Array.isArray(scene.actions) ||
    scene.actions.length < 1 ||
    scene.actions.length > 32
  ) {
    throw new Error('invalid_scene');
  }
  if (
    scene.organizationId !== candidate.organizationId ||
    scene.venueId !== candidate.venueId ||
    (scene.liveSystemId && scene.liveSystemId !== candidate.liveSystemId)
  ) {
    throw new Error('forbidden_scope');
  }

  const actionIds = new Set<string>();
  for (const action of scene.actions) {
    if (!action || typeof action !== 'object') throw new Error('invalid_scene_action');
    if (typeof action.id !== 'string' || !action.id || actionIds.has(action.id)) {
      throw new Error('invalid_scene_action');
    }
    actionIds.add(action.id);
    if (!isCapability(action.capability)) throw new Error('invalid_capability');
    if (!Array.isArray(action.targetProviderIds) || !Array.isArray(action.outputTargets)) {
      throw new Error('invalid_targets');
    }
    if (!action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) {
      throw new Error('invalid_scene_action');
    }
    if (!['normal','guarded','critical'].includes(String(action.safetyLevel))) {
      throw new Error('invalid_safety_level');
    }
    if (
      action.offsetMs != null &&
      (!Number.isFinite(action.offsetMs) || Number(action.offsetMs) < 0 || Number(action.offsetMs) > 60_000)
    ) {
      throw new Error('invalid_scene_offset');
    }
  }

  return candidate as SceneExecutionRequest;
}

function validateCachedScenes(value: unknown): Scene[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid_scenes_cache');

  const ids = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_scene');
    const scene = raw as Scene;

    if (
      typeof scene.id !== 'string' ||
      !scene.id ||
      ids.has(scene.id) ||
      typeof scene.organizationId !== 'string' ||
      !scene.organizationId ||
      typeof scene.venueId !== 'string' ||
      !scene.venueId ||
      typeof scene.name !== 'string' ||
      !scene.name.trim() ||
      !Array.isArray(scene.actions) ||
      scene.actions.length < 1 ||
      scene.actions.length > 32
    ) {
      throw new Error('invalid_scene');
    }
    ids.add(scene.id);

    const actionIds = new Set<string>();
    for (const action of scene.actions) {
      if (
        !action ||
        typeof action !== 'object' ||
        typeof action.id !== 'string' ||
        !action.id ||
        actionIds.has(action.id) ||
        !isCapability(action.capability) ||
        !Array.isArray(action.targetProviderIds) ||
        !Array.isArray(action.outputTargets) ||
        !action.payload ||
        typeof action.payload !== 'object' ||
        Array.isArray(action.payload) ||
        !['normal','guarded','critical'].includes(String(action.safetyLevel))
      ) {
        throw new Error('invalid_scene_action');
      }
      actionIds.add(action.id);
      if (
        action.offsetMs != null &&
        (!Number.isFinite(action.offsetMs) || Number(action.offsetMs) < 0 || Number(action.offsetMs) > 60_000)
      ) {
        throw new Error('invalid_scene_offset');
      }
    }
    return scene;
  });
}

function assertCachedSceneScope(
  scenes: Scene[],
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  for (const scene of scenes) {
    if (
      scene.organizationId !== binding.organizationId ||
      scene.venueId !== binding.venueId ||
      (scene.liveSystemId && scene.liveSystemId !== binding.liveSystemId)
    ) {
      throw new Error('forbidden_scope');
    }
  }
}

function validateCommand(value: unknown): LiveCommand {
  if (!value || typeof value !== 'object') throw new Error('invalid_command');
  const candidate = value as Partial<LiveCommand>;
  const requiredStrings = [
    candidate.id,
    candidate.correlationId,
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSystemId,
    candidate.liveSessionId,
    candidate.actorId,
    candidate.idempotencyKey,
    candidate.createdAt
  ];
  if (requiredStrings.some(item => typeof item !== 'string' || !item)) {
    throw new Error('invalid_command');
  }
  if (!isCapability(candidate.capability)) throw new Error('invalid_capability');
  if (!Array.isArray(candidate.targetProviderIds) || !Array.isArray(candidate.outputTargets)) {
    throw new Error('invalid_targets');
  }
  if (!['live-ui','pastor','conductor','automation','api'].includes(String(candidate.origin))) {
    throw new Error('invalid_origin');
  }
  if (!['normal','guarded','critical'].includes(String(candidate.safetyLevel))) {
    throw new Error('invalid_safety_level');
  }
  return candidate as LiveCommand;
}

function validateLiveChatMessage(value: unknown): LiveChatMessage {
  if (!value || typeof value !== 'object') throw new Error('invalid_live_chat_message');
  const candidate = value as Partial<LiveChatMessage>;
  const required = [
    candidate.id,
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSystemId,
    candidate.liveSessionId,
    candidate.actorId,
    candidate.createdAt
  ];
  if (required.some(item => typeof item !== 'string' || !item)) {
    throw new Error('invalid_live_chat_message');
  }
  if (!['operator','pastor','conductor','team'].includes(String(candidate.senderContext))) {
    throw new Error('invalid_live_chat_sender');
  }
  if (!['team','operator','pastor','conductor','production'].includes(String(candidate.audience))) {
    throw new Error('invalid_live_chat_audience');
  }
  if (typeof candidate.text !== 'string') throw new Error('invalid_live_chat_text');
  const text = candidate.text.trim();
  if (!text || text.length > 1200) throw new Error('invalid_live_chat_text');
  if (candidate.replyToId !== undefined && typeof candidate.replyToId !== 'string') {
    throw new Error('invalid_live_chat_reply');
  }
  if (candidate.relatedRequestId !== undefined && typeof candidate.relatedRequestId !== 'string') {
    throw new Error('invalid_live_chat_request');
  }
  if (candidate.relatedServiceItemId !== undefined && typeof candidate.relatedServiceItemId !== 'string') {
    throw new Error('invalid_live_chat_service_item');
  }

  return {
    ...(candidate as LiveChatMessage),
    text
  };
}

function assertLiveChatScope(
  message: LiveChatMessage,
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  if (
    message.organizationId !== binding.organizationId ||
    message.venueId !== binding.venueId ||
    message.liveSystemId !== binding.liveSystemId
  ) {
    throw new Error('forbidden_scope');
  }
}

function validateLiveRequest(value: unknown): LiveRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid_live_request');
  const candidate = value as Partial<LiveRequest>;
  const required = [
    candidate.id,
    candidate.organizationId,
    candidate.venueId,
    candidate.liveSessionId,
    candidate.actorId,
    candidate.createdAt
  ];
  if (required.some(item => typeof item !== 'string' || !item)) {
    throw new Error('invalid_live_request');
  }
  if (!['bible','song','section','media','message'].includes(String(candidate.kind))) {
    throw new Error('invalid_live_request_kind');
  }
  if (candidate.status !== 'sent') throw new Error('invalid_live_request_status');
  if (candidate.priority !== undefined && !['normal','urgent'].includes(String(candidate.priority))) {
    throw new Error('invalid_live_request_priority');
  }
  if (!candidate.payload || typeof candidate.payload !== 'object' || Array.isArray(candidate.payload)) {
    throw new Error('invalid_live_request_payload');
  }
  return candidate as LiveRequest;
}

function assertLiveRequestScope(
  request: LiveRequest,
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  if (
    request.organizationId !== binding.organizationId ||
    request.venueId !== binding.venueId
  ) {
    throw new Error('forbidden_scope');
  }
}

async function authorize(req: IncomingMessage) {
  const token = bearerToken(req);
  if (DEV_TOKEN && token === DEV_TOKEN) {
    return { dev: true as const, token, binding: null, collaboration: null };
  }
  const binding = await pairingStore.authorize(token);
  if (binding) {
    return { dev: false as const, token, binding, collaboration: null };
  }
  const collaboration = await collaborationInviteStore.authorize(token);
  return collaboration
    ? {
        dev: false as const,
        token,
        binding: collaboration.binding,
        collaboration: collaboration.grant
      }
    : null;
}

function collaborationRouteAllowed(
  method: string | undefined,
  pathname: string
): boolean {
  if (method === 'GET' && ['/health', '/state', '/capabilities', '/chat', '/requests'].includes(pathname)) {
    return true;
  }
  if (method === 'POST' && ['/heartbeat', '/chat', '/requests', '/commands'].includes(pathname)) {
    return true;
  }
  return Boolean(
    method === 'POST' &&
    pathname.startsWith('/requests/') &&
    pathname.endsWith('/status')
  );
}

function collaborationCanRequest(
  grant: NonNullable<Awaited<ReturnType<typeof authorize>>>['collaboration'],
  request: LiveRequest
): boolean {
  if (!grant) return true;
  if (request.liveSessionId !== grant.liveSessionId || request.actorId !== grant.actorId) {
    return false;
  }
  const permission = `request.${request.kind}`;
  return grant.permissions.includes(permission as (typeof grant.permissions)[number]);
}

function liveDropScopeFromSession(
  session: Awaited<ReturnType<typeof authorize>>
): LiveDropScope {
  if (!session?.binding) throw new Error('live_drop_pairing_scope_required');
  return {
    organizationId: session.binding.organizationId,
    venueId: session.binding.venueId,
    liveSystemId: session.binding.liveSystemId
  };
}

function liveDropHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

function decodeLiveDropFileName(req: IncomingMessage): string {
  const encoded = liveDropHeader(req, 'x-live-file-name');
  if (!encoded) throw new Error('invalid_live_drop_file_name');
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new Error('invalid_live_drop_file_name');
  }
}

function assertSceneScope(
  request: SceneExecutionRequest,
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  if (
    request.organizationId !== binding.organizationId ||
    request.venueId !== binding.venueId ||
    request.liveSystemId !== binding.liveSystemId
  ) {
    throw new Error('forbidden_scope');
  }
}

function assertCommandScope(
  command: LiveCommand,
  binding: Awaited<ReturnType<typeof pairingStore.authorize>>
): void {
  if (!binding) return;
  if (
    command.organizationId !== binding.organizationId ||
    command.venueId !== binding.venueId ||
    command.liveSystemId !== binding.liveSystemId
  ) {
    throw new Error('forbidden_scope');
  }
}

async function setProviderRouteSelection(
  group: ProviderRouteGroup,
  providerId: string | null
): Promise<Partial<Record<ProviderRouteGroup, string>>> {
  if (![
    'presentation','songs','bible','media','stage','visual','audio','automation'
  ].includes(group)) {
    throw new Error('invalid_route_group');
  }

  if (providerId) {
    const provider = capabilityEngine.get(providerId);
    if (!provider) throw new Error('route_provider_missing');
    const supportsGroup = [...provider.capabilities()]
      .some(capability => routeGroupForCapability(capability) === group);
    if (!supportsGroup) throw new Error('route_provider_incompatible');
  }

  await providerRoutingStore.set(group, providerId);
  return providerRoutingStore.all();
}

async function finalizeCommand(
  command: LiveCommand,
  results: CommandResult[]
): Promise<CommandResult[]> {
  await eventLogStore.append(eventFromCommand(command, results)).catch(error => {
    console.error(JSON.stringify({
      event: 'live_event_log_append_failed',
      commandId: command.id,
      error: error instanceof Error ? error.message : 'unknown'
    }));
  });
  return results;
}

async function executeUncached(command: LiveCommand): Promise<CommandResult[]> {
  let targets = command.targetProviderIds.length
    ? command.targetProviderIds
        .map(id => capabilityEngine.get(id))
        .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider))
    : [];

  if (!command.targetProviderIds.length) {
    const candidates = capabilityEngine.targetsFor(command.capability);
    const routeGroup = routeGroupForCapability(command.capability);
    const preferredProviderId = await providerRoutingStore.get(routeGroup);

    if (preferredProviderId) {
      const preferred = capabilityEngine.get(preferredProviderId);
      if (preferred?.capabilities().has(command.capability)) {
        targets = [preferred];
      } else {
        const result: CommandResult[] = [{
          commandId: command.id,
          providerInstanceId: preferredProviderId,
          accepted: false,
          latencyMs: 0,
          errorCode: 'configured_provider_route_unavailable',
          recoverable: true
        }];
        return finalizeCommand(command, result);
      }
    } else if (candidates.length === 1) {
      targets = candidates;
    } else if (candidates.length > 1) {
      const result: CommandResult[] = [{
        commandId: command.id,
        providerInstanceId: 'ambiguous',
        accepted: false,
        latencyMs: 0,
        errorCode: 'ambiguous_provider_route',
        recoverable: true
      }];
      return finalizeCommand(command, result);
    }
  }

  if (!targets.length) {
    const result: CommandResult[] = [{
      commandId: command.id,
      providerInstanceId: 'none',
      accepted: false,
      latencyMs: 0,
      errorCode: 'no_provider_for_capability',
      recoverable: true
    }];
    return finalizeCommand(command, result);
  }

  const results = await Promise.all(targets.map(async provider => {
    if (!provider.capabilities().has(command.capability)) {
      return {
        commandId: command.id,
        providerInstanceId: provider.descriptor.id,
        accepted: false,
        latencyMs: 0,
        errorCode: 'capability_not_supported',
        recoverable: true
      } satisfies CommandResult;
    }
    return provider.execute(command);
  }));

  const current = await runtimeState.load();
  const providerObservedState = { ...current.providerObservedState };
  for (const result of results) {
    if (result.accepted && result.observedState) {
      providerObservedState[result.providerInstanceId] = {
        ...(providerObservedState[result.providerInstanceId] || {}),
        ...sanitizeObservedStateForPersistence(result.observedState)
      };
    }
  }
  const anyAccepted = results.some(result => result.accepted);
  const nextServicePlan =
    anyAccepted && command.serviceItemId && current.servicePlan
      ? {
          ...current.servicePlan,
          items: current.servicePlan.items.map(item => {
            if (item.id === command.serviceItemId) {
              return { ...item, state: 'live' as const };
            }
            if (item.state === 'live') {
              return { ...item, state: 'completed' as const };
            }
            return item;
          })
        }
      : current.servicePlan;

  await runtimeState.patch({
    activeLiveSessionId: command.liveSessionId,
    activeServiceItemId: anyAccepted
      ? command.serviceItemId || current.activeServiceItemId
      : current.activeServiceItemId,
    providerObservedState,
    servicePlan: nextServicePlan
  });

  return finalizeCommand(command, results);
}

async function execute(command: LiveCommand): Promise<CommandResult[]> {
  return idempotency.run(
    command.idempotencyKey,
    () => executeUncached(command)
  );
}

const sceneExecutor = new SceneExecutor({ executeCommand: execute });

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function webAppAvailable(): Promise<boolean> {
  try {
    return (await stat(join(WEB_ROOT, 'index.html'))).isFile();
  } catch {
    return false;
  }
}

async function serveWebApp(res: ServerResponse, pathname: string): Promise<boolean> {
  if (!(await webAppAvailable())) return false;

  let requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!requested || requested.includes('..')) requested = 'index.html';

  let target = resolve(WEB_ROOT, requested);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) {
    target = join(WEB_ROOT, 'index.html');
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not_file');
  } catch {
    target = join(WEB_ROOT, 'index.html');
  }

  try {
    const data = await readFile(target);
    const extension = extname(target).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
    const basename = target.split(sep).pop() || '';
    const mustRevalidate =
      extension === '.html' ||
      basename === 'sw.js' ||
      basename === 'registerSW.js' ||
      basename === 'manifest.webmanifest';
    res.setHeader(
      'Cache-Control',
      mustRevalidate
        ? 'no-cache,no-store,must-revalidate'
        : 'public,max-age=31536000,immutable'
    );
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function localConsoleHtml(): string {
  const addresses = lanAddresses()
    .map(ip => `<li>http://${ip}:${PORT}</li>`)
    .join('');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NestLive Node</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#f5f6fa;background:#0b0c11}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 70% 10%,#241d4a 0,transparent 35%),#0b0c11}
main{width:min(680px,calc(100vw - 32px));background:#12131a;border:1px solid #292b36;border-radius:24px;padding:32px;box-shadow:0 24px 90px #0008}
small{color:#aaaebe}.brand{letter-spacing:.16em;color:#9b8cff;font-size:11px;font-weight:800}.pin{font-size:58px;letter-spacing:.12em;font-variant-numeric:tabular-nums;margin:18px 0}.muted{color:#8e93a5}.box{background:#0d0e14;border:1px solid #252733;border-radius:16px;padding:18px;margin-top:18px}code{color:#b8aeff}ul{padding-left:20px}.field{display:grid;gap:6px;margin-top:10px}.field span{font-size:11px;color:#8e93a5}.field input,.field select{background:#111219;border:1px solid #2d303c;color:#f5f6fa;border-radius:10px;padding:10px 11px;font:inherit}.routing-field{margin-top:12px}.row{display:flex;gap:8px;align-items:center;margin-top:12px}.btn{border:0;border-radius:10px;background:#7c5cff;color:white;padding:10px 13px;font:inherit;font-weight:700;cursor:pointer}.btn.secondary{background:#191b24;color:#d9dbe4;border:1px solid #2a2d38}.statusline{font-size:11px;color:#8e93a5;margin-top:10px;line-height:1.45}
.hero-note{margin:18px 0 0;padding:14px 16px;border:1px solid rgba(74,141,255,.18);background:linear-gradient(90deg,rgba(74,141,255,.08),rgba(74,141,255,.025));border-radius:16px}
.hero-note strong{display:block;font-size:13px}.hero-note span{display:block;margin-top:5px;color:#8e93a5;font-size:11px;line-height:1.5}
.connect-card{display:grid;grid-template-columns:180px 1fr;gap:20px;align-items:center;background:radial-gradient(circle at 0 50%,rgba(124,92,255,.13),transparent 45%),#0d0e14}
.connect-card img{width:164px;height:164px;background:#fff;border-radius:18px;padding:9px;box-shadow:0 16px 42px #0006}
.connect-card h2{margin:4px 0 7px;font-size:22px;letter-spacing:-.03em}.connect-card p{margin:0;color:#8e93a5;font-size:12px;line-height:1.55}
.connect-badge{display:inline-flex;margin-top:12px;padding:6px 9px;border-radius:999px;border:1px solid rgba(46,182,125,.18);background:rgba(46,182,125,.07);color:#79dcb0;font-size:10px;font-weight:700}
.provider-card{border-color:rgba(255,255,255,.06)}.provider-card>header{display:flex;align-items:center;justify-content:space-between;gap:12px}.provider-card>header>div{min-width:0}.provider-card>header strong{display:block;margin-top:4px;font-size:15px}.provider-card>header small{color:#aaaebe}.provider-card .statusline{margin:10px 0 0}
details.advanced{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.06)}details.advanced>summary{cursor:pointer;color:#7f8495;font-size:10px;list-style:none}details.advanced>summary::-webkit-details-marker{display:none}details.advanced>summary:after{content:" +";color:#656a79}details.advanced[open]>summary:after{content:" −"}
.tech-list{color:#7f8495;font-size:11px;line-height:1.55}.tech-list code{color:#aaa0e8}
@media(max-width:620px){main{padding:22px}.connect-card{grid-template-columns:1fr;text-align:center}.connect-card img{margin:auto}.connect-badge{justify-self:center}}
</style>
</head>
<body><main>
<div class="brand">MUSICSCALE / LIVE NODE</div>
<h1 id="node-display-name">${nodeDisplayName}</h1>
<p class="muted">Node <code>${nodeId}</code> · v${VERSION}</p>
<div class="hero-note"><strong>Conexão local, sem complicação</strong><span>Use o mesmo Wi‑Fi ou a mesma rede cabeada da igreja. A internet não é necessária para operar localmente. Redes de convidados podem impedir que os aparelhos se encontrem.</span></div>
<div class="box provider-card">
<header><div><small>NOME DESTE COMPUTADOR</small><strong>Use um nome que qualquer voluntário reconheça</strong></div><button class="btn" onclick="saveNodeProfile()">Salvar</button></header>
<div class="field"><span>Ex.: Computador da Projeção</span><input id="node-name" value="" maxlength="64" autocomplete="off"/></div>
<div id="profile-status" class="statusline">Carregando nome…</div>
</div>
<div class="box connect-card">
<img src="/local/connect-qr.svg" alt="QR para abrir o NestLive na rede local"/>
<div><small>CONECTAR TABLET OU CELULAR</small><h2>Escaneie e continue</h2><p>Abra a câmera do aparelho do operador e escaneie este QR. O Live abre pelo caminho local correto — sem digitar IP ou porta.</p><span class="connect-badge">Internet não obrigatória</span></div>
</div>
<div class="box">
<small>CÓDIGO DE PAREAMENTO ATIVO</small>
<div id="pin" class="pin">------</div>
<p id="status" class="muted">Solicite o pareamento no NestLive. O código aparece somente neste computador.</p>
</div>
<div class="box provider-card">
<header><div><small>APRESENTAÇÃO · HOLYRICS</small><strong>Holyrics</strong></div><button class="btn secondary" onclick="refreshProvider()">Verificar</button></header>
<div id="provider-status" class="statusline">Verificando configuração…</div>
<details class="advanced"><summary>Configurar Holyrics</summary>
<p class="muted" style="font-size:11px;line-height:1.5">Ative o API Server local uma única vez no Holyrics e cole o token gerado. O endereço técnico abaixo já usa o padrão local e normalmente não precisa ser alterado.</p>
<div class="field"><span>Token do Holyrics</span><input id="holyrics-token" type="password" placeholder="Cole o token criado no Holyrics" autocomplete="new-password"/></div>
<div class="field"><span>Avançado · endereço da API local</span><input id="holyrics-url" value="http://127.0.0.1:8091" autocomplete="off"/></div>
<div class="row"><button class="btn" onclick="saveHolyrics()">Salvar e testar</button></div>
</details>
</div>
<div class="box provider-card">
<header><div><small>VISUAIS · RESOLUME</small><strong>Resolume Arena / Avenue</strong></div><button class="btn" onclick="saveResolume()">Conectar</button></header>
<div id="resolume-status" class="statusline">Verificando configuração…</div>
<details class="advanced"><summary>Detalhes avançados</summary>
<p class="muted" style="font-size:11px;line-height:1.5">Ative Webserver / REST API no Resolume. Quando ele está neste mesmo computador, o Live usa automaticamente o endereço padrão local.</p>
<div class="field"><span>Endereço do Webserver / REST API</span><input id="resolume-url" value="http://127.0.0.1:8080" autocomplete="off"/></div>
</details>
</div>
<div class="box provider-card">
<header><div><small>APRESENTAÇÃO · PROPRESENTER</small><strong>ProPresenter</strong></div><button class="btn secondary" onclick="refreshProvider()">Verificar</button></header>
<div id="propresenter-status" class="statusline">Verificando configuração…</div>
<details class="advanced"><summary>Configurar ProPresenter</summary>
<p class="muted" style="font-size:11px;line-height:1.5">Ative Network no ProPresenter. Como a porta pode variar por instalação, informe aqui exatamente o endereço exibido pelo próprio ProPresenter.</p>
<div class="field"><span>Endereço da Network API</span><input id="propresenter-url" value="" placeholder="Ex.: 127.0.0.1:porta exibida no ProPresenter" autocomplete="off"/></div>
<div class="row"><button class="btn" onclick="saveProPresenter()">Salvar e testar</button></div>
</details>
</div>
<div class="box" id="routing-box" style="display:none">
<small>QUEM CONTROLA O QUÊ</small>
<p class="muted" style="font-size:11px;line-height:1.45">Quando mais de um provider consegue executar a mesma função, escolha aqui quem é o principal. Com apenas um provider compatível, o Live roteia automaticamente.</p>
<div id="routing-controls"></div>
<div id="routing-status" class="statusline"></div>
</div>
<div class="box">
<small>DIAGNÓSTICO LOCAL</small>
<div class="row">
<button class="btn secondary" onclick="downloadDiagnostics()">Baixar diagnóstico</button>
<button class="btn secondary" onclick="downloadCertificationReport()">Relatório de certificação</button>
<span class="muted" style="font-size:11px">Os arquivos não incluem token do Holyrics nem credenciais de pareamento.</span>
</div>
</div>
<details class="box advanced"><summary>Detalhes técnicos da rede</summary><div class="tech-list"><p>Use estes endereços somente para diagnóstico ou fallback manual.</p><ul>${addresses || '<li>Nenhum IPv4 LAN detectado</li>'}</ul></div></details>
<script>
async function refreshNodeProfile(){
  try{
    const r=await fetch('/local/profile',{cache:'no-store'});
    const d=await r.json();
    if(!r.ok)return;
    document.getElementById('node-name').value=d.displayName||'';
    document.getElementById('node-display-name').textContent=d.displayName||'NestLive Node';
    document.getElementById('profile-status').textContent=d.tutorialCompletedAt?'Nome salvo · tutorial concluído':'Nome salvo · finalize o guia rápido no tablet.';
  }catch{}
}
async function saveNodeProfile(){
  const input=document.getElementById('node-name');
  const status=document.getElementById('profile-status');
  const displayName=input.value.trim();
  if(!displayName){status.textContent='Digite um nome simples para este computador.';return}
  status.textContent='Salvando…';
  try{
    const r=await fetch('/local/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName})});
    const d=await r.json();
    if(!r.ok){status.textContent='Não foi possível salvar.';return}
    input.value=d.displayName||displayName;
    document.getElementById('node-display-name').textContent=d.displayName||displayName;
    status.textContent='Pronto. Este nome aparecerá na descoberta da rede.';
  }catch{status.textContent='Não foi possível salvar.'}
}
async function refresh(){
  try{
    const r=await fetch('/local/pairing',{cache:'no-store'});
    if(!r.ok){document.getElementById('status').textContent='Abra esta página no próprio computador do Live Node para ver o PIN.';return}
    const d=await r.json();
    document.getElementById('pin').textContent=d.pin||'------';
    document.getElementById('status').textContent=d.pin?'Digite este código no NestLive. Expira em até 2 minutos.':'Aguardando solicitação de pareamento…';
  }catch{}
}
function routeGroupForCapabilityClient(capability){
  if(capability.startsWith('presentation.')||capability==='preview.snapshot')return 'presentation';
  if(capability.startsWith('songs.')||capability.startsWith('playlist.'))return 'songs';
  if(capability.startsWith('bible.'))return 'bible';
  if(capability.startsWith('media.'))return 'media';
  if(capability.startsWith('stage.'))return 'stage';
  if(capability.startsWith('visual.'))return 'visual';
  if(capability.startsWith('audio.'))return 'audio';
  return 'automation';
}
function routeGroupLabel(group){
  return ({
    presentation:'Apresentação / slides',
    songs:'Músicas / playlists',
    bible:'Bíblia',
    media:'Mídia',
    stage:'Palco / comunicação',
    visual:'Visuais',
    audio:'Áudio',
    automation:'Automações'
  })[group]||group;
}
function renderRouting(providers,routing){
  const box=document.getElementById('routing-box');
  const root=document.getElementById('routing-controls');
  const groups=['presentation','songs','bible','media','stage','visual','audio','automation'];
  const rows=[];

  for(const group of groups){
    const candidates=(providers||[]).filter(provider =>
      Array.isArray(provider.capabilities) &&
      provider.capabilities.some(cap => routeGroupForCapabilityClient(cap)===group)
    );
    if(candidates.length<2) continue;

    const options=[
      '<option value="">Escolha o provider principal…</option>',
      ...candidates.map(provider => {
        const selected=routing&&routing[group]===provider.providerId?' selected':'';
        const health=provider.health==='online'?' · online':' · '+provider.health;
        return '<option value="'+provider.providerId+'"'+selected+'>'+provider.displayName+health+'</option>';
      })
    ].join('');

    rows.push(
      '<label class="field routing-field"><span>'+routeGroupLabel(group)+'</span>'+
      '<select data-route-group="'+group+'" onchange="saveRoute(this)">'+options+'</select></label>'
    );
  }

  root.innerHTML=rows.join('');
  box.style.display=rows.length?'block':'none';
}
async function saveRoute(select){
  const status=document.getElementById('routing-status');
  const group=select.dataset.routeGroup;
  const providerId=select.value||null;
  status.textContent='Salvando roteamento…';
  try{
    const r=await fetch('/local/routing',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({group,providerId})
    });
    const d=await r.json();
    if(!r.ok){
      status.textContent='Falha: '+(d.error||'não foi possível salvar');
      return;
    }
    status.textContent=providerId
      ? routeGroupLabel(group)+' definido.'
      : routeGroupLabel(group)+' voltará ao roteamento automático quando não houver ambiguidade.';
  }catch{
    status.textContent='Não foi possível salvar o roteamento.';
  }
}
async function refreshProvider(){
  const el=document.getElementById('provider-status');
  try{
    const r=await fetch('/local/providers',{cache:'no-store'});
    const d=await r.json();
    if(!r.ok){el.textContent='Configuração disponível apenas neste computador.';return}
    renderRouting(d.providers||[],d.routing||{});
    const h=d.holyrics||{};
    document.getElementById('holyrics-url').value=h.baseUrl||'http://127.0.0.1:8091';
    if(!h.configured){
      el.textContent='Holyrics ainda não configurado.';
    }else{
      const count=Array.isArray(h.capabilities)?h.capabilities.length:0;
      el.textContent=(h.health==='online'?'Conectado':'Configurado, mas offline')+' · '+count+' capacidades detectadas'+(h.source==='environment'?' · gerenciado pelo ambiente':'');
    }

    const re=d.resolume||{};
    const rel=document.getElementById('resolume-status');
    document.getElementById('resolume-url').value=re.baseUrl||'http://127.0.0.1:8080';
    if(!re.configured){
      rel.textContent='Resolume não encontrado neste computador. Se você usa Arena/Avenue aqui, ative Webserver / REST API e clique em Conectar.';
    }else{
      const count=Array.isArray(re.capabilities)?re.capabilities.length:0;
      rel.textContent=(re.health==='online'?'Conectado':'Configurado, mas offline')+' · '+count+' capacidades detectadas'+(re.source==='detected'?' · encontrado automaticamente':re.source==='environment'?' · gerenciado pelo ambiente':'');
    }

    const pp=d.propresenter||{};
    const pel=document.getElementById('propresenter-status');
    document.getElementById('propresenter-url').value=pp.baseUrl||'';
    if(!pp.configured){
      pel.textContent='ProPresenter ainda não configurado.';
    }else{
      const count=Array.isArray(pp.capabilities)?pp.capabilities.length:0;
      pel.textContent=(pp.health==='online'?'Conectado':'Configurado, mas offline')+' · '+count+' capacidades detectadas'+(pp.source==='environment'?' · gerenciado pelo ambiente':'');
    }
  }catch{
    el.textContent='Não foi possível ler a configuração.';
    document.getElementById('resolume-status').textContent='Não foi possível ler a configuração.';
    document.getElementById('propresenter-status').textContent='Não foi possível ler a configuração.';
  }
}
async function downloadCertificationReport(){
  try{
    const r=await fetch('/local/certification-report',{cache:'no-store'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'certification_report_failed');
    const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='nestlive-certification-report.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }catch(error){
    alert('Não foi possível gerar o relatório de certificação.');
  }
}
async function downloadDiagnostics(){
  try{
    const r=await fetch('/local/diagnostics',{cache:'no-store'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'diagnostics_failed');
    const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download='nestlive-diagnostics.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }catch(error){
    alert('Não foi possível gerar o diagnóstico local.');
  }
}
async function saveProPresenter(){
  const el=document.getElementById('propresenter-status');
  const baseUrl=document.getElementById('propresenter-url').value.trim();
  if(!baseUrl){el.textContent='Informe o IP e a porta exibidos em Network no ProPresenter.';return}
  el.textContent='Salvando e testando…';
  try{
    const r=await fetch('/local/providers/propresenter',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({baseUrl})
    });
    const d=await r.json();
    if(!r.ok){el.textContent='Falha: '+(d.error||d.reason||'não foi possível conectar');return}
    el.textContent='ProPresenter conectado · '+(d.capabilities||[]).length+' capacidades'+(d.version?' · '+d.version:'');
  }catch{el.textContent='Não foi possível salvar a configuração.'}
}
async function saveResolume(){
  const el=document.getElementById('resolume-status');
  const baseUrl=document.getElementById('resolume-url').value;
  el.textContent='Salvando e testando…';
  try{
    const r=await fetch('/local/providers/resolume',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({baseUrl})
    });
    const d=await r.json();
    if(!r.ok){el.textContent='Falha: '+(d.error||d.reason||'não foi possível conectar');return}
    el.textContent='Resolume conectado · '+(d.capabilities||[]).length+' capacidades'+(d.version?' · v'+d.version:'');
  }catch{el.textContent='Não foi possível salvar a configuração.'}
}
async function saveHolyrics(){
  const el=document.getElementById('provider-status');
  const baseUrl=document.getElementById('holyrics-url').value;
  const token=document.getElementById('holyrics-token').value;
  if(!token){el.textContent='Informe o token do Holyrics para salvar.';return}
  el.textContent='Salvando e testando…';
  try{
    const r=await fetch('/local/providers/holyrics',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({baseUrl,token})
    });
    const d=await r.json();
    document.getElementById('holyrics-token').value='';
    if(!r.ok){el.textContent='Falha: '+(d.error||d.reason||'não foi possível conectar');return}
    el.textContent='Holyrics conectado · '+(d.capabilities||[]).length+' capacidades · v'+(d.version||'detectada');
  }catch{el.textContent='Não foi possível salvar a configuração.'}
}
refreshNodeProfile();refresh();refreshProvider();setInterval(refresh,1000);
</script>
</main></body></html>`;
}

async function start(): Promise<void> {
  await idempotency.load();
  await sceneIdempotency.load();
  await pairingStore.load();
  await collaborationInviteStore.load();
  await runtimeState.load();
  await providerConfigStore.load();
  await productionProviderConfigStore.load();
  await productionWorkspaceStore.load();
  await providerRoutingStore.load();
  await peerNodeStore.load();
  await signalTopologyStore.load();
  const profile = await nodeProfileStore.load();
  nodeDisplayName = profile.displayName;
  peerDiscovery.setDisplayName(nodeDisplayName);
  peerFederation.setLocalDisplayName(nodeDisplayName);
  await registerHolyricsProvider();
  await registerResolumeProvider();
  await registerProPresenterProvider();
  await registerProductionProviders();
  await peerFederation.load();
  await peerDiscovery.start();

  const server = createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/node') {
      return sendHtml(res, 200, localConsoleHtml());
    }

    if (req.method === 'GET' && url.pathname === '/local/profile') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      return send(res, 200, await nodeProfileStore.load());
    }

    if (req.method === 'POST' && url.pathname === '/local/profile') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_node_profile');
      const displayName = String((body as Record<string, unknown>).displayName || '').trim();
      if (!displayName) throw new Error('node_display_name_required');
      const profile = await nodeProfileStore.setDisplayName(displayName);
      nodeDisplayName = profile.displayName;
      peerDiscovery.setDisplayName(nodeDisplayName);
      peerFederation.setLocalDisplayName(nodeDisplayName);
      return send(res, 200, profile);
    }

    if (req.method === 'POST' && url.pathname === '/local/tutorial-complete') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      return send(res, 200, await nodeProfileStore.markTutorialComplete());
    }

    if (
      req.method === 'GET' &&
      (
        url.pathname === '/.well-known/nestlive-node' ||
        url.pathname === '/.well-known/millionsnest-live-node'
      )
    ) {
      return send(res, 200, {
        product: 'NestLive Node',
        protocolVersion: 1,
        version: VERSION,
        nodeId,
        hostname: hostname(),
        displayName: nodeDisplayName,
        port: PORT
      });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const providerSnapshot = capabilityEngine.quickSnapshot();
      return send(res, 200, {
        product: 'NestLive Node',
        version: VERSION,
        nodeId,
        hostname: hostname(),
        displayName: nodeDisplayName,
        health: providerSnapshot.some(provider => provider.health === 'degraded') ? 'degraded' : 'online',
        lanAddresses: lanAddresses(),
        providers: providerSnapshot.length,
        providersOnline: providerSnapshot.filter(
          provider => provider.health === 'online' || provider.health === 'degraded'
        ).length,
        now: new Date().toISOString(),
        pairing: {
          pairedDevices: await pairingStore.activePairingCount(),
          pairingEnabled: PAIRING_ENABLED
        },
        discovery: {
          status: peerDiscovery.status(),
          nearbyNodes: peerDiscovery.list().length
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/local/certification-report') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });

      const [runtime, pairedDevices, routing] = await Promise.all([
        runtimeState.load(),
        pairingStore.activePairingCount(),
        providerRoutingStore.all()
      ]);
      const providers = capabilityEngine.quickSnapshot();
      const requestedSessionId = String(
        url.searchParams.get('liveSessionId') ||
        runtime.activeLiveSessionId ||
        ''
      ).trim();

      const eventSummary = runtime.servicePlan
        ? await eventLogStore.summarize({
            organizationId: runtime.servicePlan.organizationId,
            venueId: runtime.servicePlan.venueId,
            liveSystemId: runtime.servicePlan.liveSystemId,
            ...(requestedSessionId ? { liveSessionId: requestedSessionId } : {})
          })
        : {
            total: 0,
            info: 0,
            warnings: 0,
            errors: 0,
            plannedActions: 0,
            plannedServiceItems: 0,
            adHocActions: 0,
            byType: {},
            providerCommandResults: 0,
            providerCommandAccepted: 0,
            providerCommandRejected: 0,
            providerLatencySamples: 0
          };

      return send(res, 200, buildCertificationReport({
        nodeId,
        version: VERSION,
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        runtime,
        providers,
        routing,
        pairedDevices,
        discovery: {
          status: peerDiscovery.status(),
          nearbyNodes: peerDiscovery.list().length
        },
        peerCount: peerFederation.publicStatus().length,
        ...(requestedSessionId ? { liveSessionId: requestedSessionId } : {}),
        eventSummary
      }));
    }

    if (req.method === 'GET' && url.pathname === '/local/diagnostics') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });

      const [runtime, pairedDevices, holyricsConfig, resolumeConfig, propresenterConfig] = await Promise.all([
        runtimeState.load(),
        pairingStore.activePairingCount(),
        providerConfigStore.getHolyrics(),
        providerConfigStore.getResolume(),
        providerConfigStore.getProPresenter()
      ]);
      const providers = capabilityEngine.quickSnapshot();

      return send(res, 200, buildLiveNodeDiagnostics({
        nodeId,
        version: VERSION,
        hostname: hostname(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        port: PORT,
        lanAddresses: lanAddresses(),
        webAppPresent: existsSync(join(WEB_ROOT, 'index.html')),
        pairingEnabled: PAIRING_ENABLED,
        pairedDevices,
        runtime,
        providers,
        holyrics: {
          configured: Boolean(HOLYRICS_TOKEN || holyricsConfig?.token),
          source: HOLYRICS_TOKEN ? 'environment' : holyricsConfig ? 'local' : 'none',
          baseUrl: HOLYRICS_TOKEN ? HOLYRICS_URL : holyricsConfig?.baseUrl || HOLYRICS_URL
        },
        resolume: {
          configured: Boolean(RESOLUME_URL || resolumeConfig?.baseUrl),
          source: RESOLUME_URL ? 'environment' : resolumeConfig ? 'local' : 'none',
          baseUrl: RESOLUME_URL || resolumeConfig?.baseUrl || DEFAULT_RESOLUME_URL
        },
        propresenter: {
          configured: Boolean(PROPRESENTER_URL || propresenterConfig?.baseUrl),
          source: PROPRESENTER_URL ? 'environment' : propresenterConfig ? 'local' : 'none',
          baseUrl: PROPRESENTER_URL || propresenterConfig?.baseUrl || ''
        }
      }));
    }

    if (req.method === 'GET' && url.pathname === '/local/connect-qr.svg') {
      // The QR contains only the same LAN URL already shown on the local console.
      // Do not require loopback here: when the console is opened through this
      // computer's LAN address, the browser request is not seen as 127.0.0.1.
      const socketAddress = (req.socket.localAddress || '').replace(/^::ffff:/, '');
      const lan = lanAddresses();
      const ip = lan.includes(socketAddress) ? socketAddress : (lan[0] || '127.0.0.1');
      const target = `http://${ip}:${PORT}/`;
      const svg = await qrToString(target, {
        type: 'svg',
        margin: 1,
        width: 320,
        errorCorrectionLevel: 'M'
      });
      return sendSvg(res, 200, svg);
    }

    if (req.method === 'GET' && url.pathname === '/local/providers') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const [holyricsConfig, resolumeConfig, propresenterConfig, routing] = await Promise.all([
        providerConfigStore.getHolyrics(),
        providerConfigStore.getResolume(),
        providerConfigStore.getProPresenter(),
        providerRoutingStore.all()
      ]);
      const snapshot = capabilityEngine.quickSnapshot();
      const holyrics = snapshot.find(provider => provider.providerId === 'holyrics-primary');
      const resolume = snapshot.find(provider => provider.providerId === 'resolume-primary');
      const propresenter = snapshot.find(provider => provider.providerId === 'propresenter-primary');
      const providers = snapshot.map(provider => {
        const descriptor = capabilityEngine.get(provider.providerId)?.descriptor;
        return {
          ...provider,
          displayName: descriptor?.displayName || provider.providerId,
          providerKey: descriptor?.providerKey || 'unknown',
          kind: descriptor?.kind || 'control',
          nodeId: descriptor?.nodeId || nodeId
        };
      });
      return send(res, 200, {
        providers,
        routing,
        holyrics: {
          configured: Boolean(HOLYRICS_TOKEN || holyricsConfig?.token),
          source: HOLYRICS_TOKEN ? 'environment' : holyricsConfig ? 'local' : 'none',
          baseUrl: HOLYRICS_TOKEN ? HOLYRICS_URL : holyricsConfig?.baseUrl || HOLYRICS_URL,
          health: holyrics?.health || 'offline',
          capabilities: holyrics?.capabilities || [],
          observed: holyrics?.observed || {}
        },
        resolume: {
          configured: Boolean(RESOLUME_URL || resolumeConfig?.baseUrl || resolume),
          source: RESOLUME_URL
            ? 'environment'
            : resolumeConfig
              ? 'local'
              : resolume
                ? 'detected'
                : 'none',
          baseUrl: RESOLUME_URL || resolumeConfig?.baseUrl || DEFAULT_RESOLUME_URL,
          health: resolume?.health || 'offline',
          capabilities: resolume?.capabilities || [],
          observed: resolume?.observed || {}
        },
        propresenter: {
          configured: Boolean(PROPRESENTER_URL || propresenterConfig?.baseUrl),
          source: PROPRESENTER_URL ? 'environment' : propresenterConfig ? 'local' : 'none',
          baseUrl: PROPRESENTER_URL || propresenterConfig?.baseUrl || '',
          health: propresenter?.health || 'offline',
          capabilities: propresenter?.capabilities || [],
          observed: propresenter?.observed || {}
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/holyrics') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (HOLYRICS_TOKEN) {
        return send(res, 409, { error: 'holyrics_managed_by_environment' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_holyrics_config');
      const candidate = body as Record<string, unknown>;
      const baseUrl = String(candidate.baseUrl || HOLYRICS_URL);
      const token = String(candidate.token || '');
      await providerConfigStore.setHolyrics({ baseUrl, token });
      const result = await registerHolyricsProvider();
      return send(res, result.probe?.reachable ? 200 : 422, {
        configured: result.configured,
        source: result.source,
        baseUrl: result.baseUrl,
        reachable: result.probe?.reachable || false,
        version: result.probe?.version || null,
        capabilities: result.probe?.capabilities || [],
        reason: result.probe?.reason || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/resolume') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (RESOLUME_URL) {
        return send(res, 409, { error: 'resolume_managed_by_environment' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_resolume_config');
      const candidate = body as Record<string, unknown>;
      const baseUrl = String(candidate.baseUrl || DEFAULT_RESOLUME_URL);
      await providerConfigStore.setResolume({ baseUrl });
      const result = await registerResolumeProvider();
      return send(res, result.probe?.reachable ? 200 : 422, {
        configured: result.configured,
        source: result.source,
        baseUrl: result.baseUrl,
        reachable: result.probe?.reachable || false,
        version: result.probe?.version || null,
        capabilities: result.probe?.capabilities || [],
        reason: result.probe?.reason || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/propresenter') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (PROPRESENTER_URL) {
        return send(res, 409, { error: 'propresenter_managed_by_environment' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_propresenter_config');
      const candidate = body as Record<string, unknown>;
      const baseUrl = String(candidate.baseUrl || '').trim();
      if (!baseUrl) throw new Error('propresenter_url_required');
      await providerConfigStore.setProPresenter({ baseUrl });
      const result = await registerProPresenterProvider();
      return send(res, result.probe?.reachable ? 200 : 422, {
        configured: result.configured,
        source: result.source,
        baseUrl: result.baseUrl,
        reachable: result.probe?.reachable || false,
        version: result.probe?.version || null,
        capabilities: result.probe?.capabilities || [],
        reason: result.probe?.reason || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/propresenter/clear') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (PROPRESENTER_URL) {
        return send(res, 409, { error: 'propresenter_managed_by_environment' });
      }
      await providerConfigStore.clearProPresenter();
      capabilityEngine.unregister('propresenter-primary');
      return send(res, 200, { cleared: true });
    }

    if (req.method === 'GET' && url.pathname === '/local/providers/production') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      return send(res, 200, {
        catalog: Object.values(PRODUCTION_ADAPTER_MANIFESTS).map(manifest => ({
          adapterKey: manifest.adapterKey,
          displayName: manifest.displayName,
          providerKind: manifest.providerKind,
          transport: manifest.transport,
          capabilities: manifest.capabilities,
          setup: manifest.setup.map(field => ({
            key: field.key,
            label: field.label,
            kind: field.kind,
            required: field.required,
            advanced: field.advanced === true,
            secret: field.secret === true || field.kind === 'secret',
            defaultValue: field.defaultValue,
            help: field.help
          })),
          experimental: manifest.experimental === true
        })),
        providers: await productionProviderConfigStore
          .allPublic(PRODUCTION_ADAPTER_MANIFESTS),
        probes: capabilityEngine.quickSnapshot()
          .filter(provider => registeredProductionProviderIds.has(provider.providerId))
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/production') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_production_provider_config');
      }
      const candidate = body as Record<string, unknown>;
      const adapterKey = String(candidate.adapterKey || '').trim();
      const manifest = productionManifestByKey(adapterKey);
      if (!manifest) throw new Error('production_adapter_unsupported');

      const instanceId = String(candidate.instanceId || '').trim();
      const displayName = String(candidate.displayName || manifest.displayName).trim();
      const config =
        candidate.config && typeof candidate.config === 'object' && !Array.isArray(candidate.config)
          ? candidate.config as Record<string, unknown>
          : {};

      await productionProviderConfigStore.upsert(manifest, {
        instanceId,
        displayName,
        config
      });
      const probes = await registerProductionProviders();
      const publicConfig = (
        await productionProviderConfigStore.allPublic(PRODUCTION_ADAPTER_MANIFESTS)
      ).find(item => item.instanceId === instanceId);

      return send(res, 200, {
        provider: publicConfig || null,
        probe: probes.find(item => item.instanceId === instanceId) || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/production/remove') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_production_provider_remove');
      }
      const instanceId = String(
        (body as Record<string, unknown>).instanceId || ''
      ).trim();
      if (!instanceId) throw new Error('production_provider_instance_required');

      const removed = await productionProviderConfigStore.remove(
        instanceId,
        PRODUCTION_ADAPTER_MANIFESTS
      );
      await registerProductionProviders();
      return send(res, 200, {
        removed,
        providers: await productionProviderConfigStore
          .allPublic(PRODUCTION_ADAPTER_MANIFESTS)
      });
    }

    if (req.method === 'GET' && url.pathname === '/production/workspace') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'production_workspace_admin_required' });
      }
      const scope = session.binding;
      return send(res, 200, {
        audioProfiles: await productionWorkspaceStore.audioProfiles(scope),
        templates: await productionWorkspaceStore.templates(scope.organizationId)
      });
    }

    if (req.method === 'POST' && url.pathname === '/production/audio-profiles') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'production_workspace_admin_required' });
      }
      const profile = await productionWorkspaceStore.upsertAudioProfile(
        await readJson(req),
        session.binding
      );
      return send(res, 200, { profile });
    }

    if (req.method === 'POST' && url.pathname === '/production/templates') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'production_workspace_admin_required' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('live_template_invalid');
      const candidate = body as Record<string, unknown>;
      const actorId = String(candidate.createdBy || '').trim();
      if (!actorId) throw new Error('live_template_creator_invalid');
      const template = await productionWorkspaceStore.upsertTemplate(
        candidate,
        session.binding.organizationId,
        actorId
      );
      return send(res, 200, { template });
    }

    if (req.method === 'POST' && url.pathname === '/local/production/templates/decision') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('live_template_review_invalid');
      }
      const candidate = body as Record<string, unknown>;
      const decision = String(candidate.decision || '');
      if (!['approved', 'rejected'].includes(decision)) {
        throw new Error('live_template_review_invalid');
      }
      const template = await productionWorkspaceStore.decideMarketplace({
        organizationId: String(candidate.organizationId || ''),
        templateId: String(candidate.templateId || ''),
        decision: decision as 'approved' | 'rejected',
        reviewerId: String(candidate.reviewerId || '')
      });
      return send(res, 200, { template });
    }

    if (req.method === 'GET' && url.pathname === '/backup/export') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'backup_admin_required' });
      }
      const [runtime, routing, signalTopology, audioProfiles, templates] =
        await Promise.all([
          runtimeState.load(),
          providerRoutingStore.all(),
          signalTopologyStore.load(),
          productionWorkspaceStore.audioProfiles(session.binding),
          productionWorkspaceStore.templates(session.binding.organizationId)
        ]);

      return send(res, 200, createLiveNodeBackup({
        appVersion: VERSION,
        nodeId,
        organizationId: session.binding.organizationId,
        venueId: session.binding.venueId,
        liveSystemId: session.binding.liveSystemId,
        servicePlan: runtime.servicePlan,
        providerLinks: runtime.providerLinks,
        scenes: runtime.scenes,
        routing,
        signalTopology,
        audioProfiles,
        templates
      }));
    }

    if (req.method === 'POST' && url.pathname === '/backup/restore') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'backup_admin_required' });
      }
      const current = await runtimeState.load();
      if (current.activeLiveSessionId) {
        return send(res, 409, { error: 'backup_restore_blocked_during_live' });
      }

      const bundle = validateLiveNodeBackup(
        await readJsonWithLimit(req, 2 * 1024 * 1024),
        session.binding
      );
      await providerRoutingStore.replace(bundle.data.routing);
      await signalTopologyStore.replace(bundle.data.signalTopology);
      await productionWorkspaceStore.replaceFromBackup({
        audioProfiles: bundle.data.audioProfiles,
        templates: bundle.data.templates,
        organizationId: session.binding.organizationId,
        venueId: session.binding.venueId,
        liveSystemId: session.binding.liveSystemId
      });
      const state = await runtimeState.patch({
        activeLiveSessionId: null,
        activeSession: null,
        activeServiceItemId: null,
        providerObservedState: {},
        servicePlan: bundle.data.servicePlan,
        providerLinks: bundle.data.providerLinks,
        scenes: bundle.data.scenes,
        requests: []
      });
      return send(res, 200, {
        restored: true,
        backupId: bundle.manifest.backupId,
        stateRevision: state.revision,
        servicePlanId: state.servicePlan?.id || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/routing') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_route');
      const candidate = body as Record<string, unknown>;
      const group = String(candidate.group || '') as ProviderRouteGroup;
      const providerId = candidate.providerId == null
        ? null
        : String(candidate.providerId).trim() || null;

      return send(res, 200, {
        group,
        providerId,
        routing: await setProviderRouteSelection(group, providerId)
      });
    }

    if (req.method === 'POST' && url.pathname === '/routing') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_route');
      const candidate = body as Record<string, unknown>;
      const group = String(candidate.group || '') as ProviderRouteGroup;
      const providerId = candidate.providerId == null
        ? null
        : String(candidate.providerId).trim() || null;

      return send(res, 200, {
        group,
        providerId,
        routing: await setProviderRouteSelection(group, providerId)
      });
    }

    if (req.method === 'GET' && url.pathname === '/local/peers') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      return send(res, 200, { peers: peerFederation.publicStatus() });
    }

    if (req.method === 'GET' && url.pathname === '/local/discovery/peers') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      return send(res, 200, {
        status: peerDiscovery.status(),
        peers: peerDiscovery.list()
      });
    }

    if (req.method === 'GET' && url.pathname === '/discovery/peers') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, {
        status: peerDiscovery.status(),
        peers: peerDiscovery.list()
      });
    }

    if (req.method === 'GET' && url.pathname === '/peers') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { peers: peerFederation.publicStatus() });
    }

    if (req.method === 'POST' && url.pathname === '/peers/pair/request') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_peer_pairing_request');
      const candidate = body as Record<string, unknown>;
      requireStrings(candidate, ['baseUrl'], 'invalid_peer_pairing_request');

      const scope = session.binding
        ? {
            organizationId: session.binding.organizationId,
            venueId: session.binding.venueId,
            liveSystemId: session.binding.liveSystemId
          }
        : {
            organizationId: String(candidate.organizationId || ''),
            venueId: String(candidate.venueId || ''),
            liveSystemId: String(candidate.liveSystemId || '')
          };

      const challenge = await peerFederation.requestPairing({
        baseUrl: String(candidate.baseUrl),
        ...scope
      });
      return send(res, 201, challenge);
    }

    if (req.method === 'POST' && url.pathname === '/peers/pair/complete') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_peer_pairing_complete');
      const candidate = body as Record<string, unknown>;
      requireStrings(
        candidate,
        ['remoteNodeId', 'pin'],
        'invalid_peer_pairing_complete'
      );
      const peer = await peerFederation.completePairing(
        String(candidate.remoteNodeId),
        String(candidate.pin)
      );
      return send(res, 201, { peer });
    }

    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/peers/') &&
      url.pathname.endsWith('/remove')
    ) {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const parts = url.pathname.split('/').filter(Boolean);
      const remoteNodeId = decodeURIComponent(parts[1] || '');
      if (!remoteNodeId) throw new Error('invalid_peer_node_id');
      return send(res, 200, {
        removed: await peerFederation.removePeer(remoteNodeId),
        peers: peerFederation.publicStatus()
      });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/resolume/clear') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (RESOLUME_URL) {
        return send(res, 409, { error: 'resolume_managed_by_environment' });
      }
      await providerConfigStore.clearResolume();
      capabilityEngine.unregister('resolume-primary');
      return send(res, 200, { cleared: true });
    }

    if (req.method === 'POST' && url.pathname === '/local/providers/holyrics/clear') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      if (HOLYRICS_TOKEN) {
        return send(res, 409, { error: 'holyrics_managed_by_environment' });
      }
      await providerConfigStore.clearHolyrics();
      capabilityEngine.unregister('holyrics-primary');
      return send(res, 200, { cleared: true });
    }

    if (req.method === 'GET' && url.pathname === '/local/pairing') {
      if (!isLoopback(req)) return send(res, 403, { error: 'local_only' });
      const challenge = pairingStore.activeChallengeForLocalDisplay();
      return send(res, 200, {
        pin: challenge?.pin || null,
        expiresAt: challenge?.expiresAt || null
      });
    }

    if (req.method === 'POST' && url.pathname === '/pairing/request') {
      if (!PAIRING_ENABLED) return send(res, 404, { error: 'pairing_not_enabled' });
      if (pairingRateLimited(req)) return send(res, 429, { error: 'pairing_rate_limited' });
      const request = validatePairingRequest(await readJson(req));
      const challenge = await pairingStore.createChallenge(request);
      console.log(JSON.stringify({
        event: 'pairing_code_created',
        nodeId,
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt,
        deviceName: request.deviceName
      }));
      return send(res, 201, {
        challengeId: challenge.challengeId,
        nodeId,
        expiresAt: challenge.expiresAt,
        method: 'pin',
        displayedOnNode: true
      });
    }

    if (req.method === 'POST' && url.pathname === '/pairing/complete') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_pairing_complete');
      const candidate = body as Record<string, unknown>;
      requireStrings(
        candidate,
        ['challengeId', 'pin', 'deviceId', 'deviceName'],
        'invalid_pairing_complete'
      );
      const completed = await pairingStore.complete(
        String(candidate.challengeId),
        String(candidate.pin),
        String(candidate.deviceId),
        String(candidate.deviceName)
      );
      return send(res, 201, completed);
    }

    if (req.method === 'POST' && url.pathname === '/collaboration/redeem') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_collaboration_redeem');
      }
      const candidate = body as Record<string, unknown>;
      requireStrings(
        candidate,
        ['inviteId', 'secret', 'actorId', 'deviceId', 'deviceName'],
        'invalid_collaboration_redeem'
      );
      const redeemed = await collaborationInviteStore.redeem({
        inviteId: String(candidate.inviteId),
        secret: String(candidate.secret),
        actorId: String(candidate.actorId),
        deviceId: String(candidate.deviceId),
        deviceName: String(candidate.deviceName)
      });
      return send(res, 201, {
        nodeId,
        token: redeemed.token,
        binding: redeemed.binding,
        collaboration: redeemed.grant
      });
    }

    if (req.method === 'POST' && url.pathname === '/collaboration/invites') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      if (!session.binding || session.collaboration) {
        return send(res, 403, { error: 'collaboration_invite_admin_required' });
      }

      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_collaboration_invite');
      }
      const candidate = body as Record<string, unknown>;
      requireStrings(
        candidate,
        ['liveSessionId', 'role', 'createdBy'],
        'invalid_collaboration_invite'
      );
      const role = String(candidate.role) as LiveCollaborationRole;
      if (!['pastor', 'conductor', 'viewer'].includes(role)) {
        throw new Error('invalid_collaboration_role');
      }
      const liveSessionId = String(candidate.liveSessionId);
      const runtime = await runtimeState.load();
      const activeSessionId = runtime.activeLiveSessionId || '';
      if (activeSessionId && activeSessionId !== liveSessionId) {
        return send(res, 409, { error: 'collaboration_session_not_active' });
      }

      const ttlMinutesRaw = Number(candidate.ttlMinutes);
      const maxUsesRaw = Number(candidate.maxUses);
      const created = await collaborationInviteStore.createInvite({
        binding: session.binding,
        liveSessionId,
        role,
        createdBy: String(candidate.createdBy),
        ...(Number.isFinite(ttlMinutesRaw)
          ? { ttlMs: Math.max(5, Math.min(720, ttlMinutesRaw)) * 60_000 }
          : {}),
        ...(Number.isFinite(maxUsesRaw)
          ? { maxUses: Math.max(1, Math.min(50, Math.floor(maxUsesRaw))) }
          : {})
      });

      const lan = lanAddresses();
      const socketAddress = (req.socket.localAddress || '').replace(/^::ffff:/, '');
      const ip = lan.includes(socketAddress) ? socketAddress : (lan[0] || '127.0.0.1');
      const joinUrl =
        `http://${ip}:${PORT}/?collabInvite=${encodeURIComponent(created.invite.id)}&collabRole=${encodeURIComponent(created.invite.role)}#collabSecret=${encodeURIComponent(created.secret)}`;
      const qrSvg = await qrToString(joinUrl, {
        type: 'svg',
        margin: 1,
        width: 320,
        errorCorrectionLevel: 'M'
      });

      return send(res, 201, {
        invite: created.invite,
        joinUrl,
        qrSvg
      });
    }

    if (req.method === 'GET' && url.pathname === '/collaboration/invites') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      if (!session.binding || session.collaboration) {
        return send(res, 403, { error: 'collaboration_invite_admin_required' });
      }
      const liveSessionId = String(url.searchParams.get('liveSessionId') || '').trim();
      return send(res, 200, {
        invites: await collaborationInviteStore.listActive(liveSessionId || undefined)
      });
    }

    if (req.method === 'POST' && url.pathname === '/collaboration/revoke-session') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      if (!session.binding || session.collaboration) {
        return send(res, 403, { error: 'collaboration_invite_admin_required' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_collaboration_revoke');
      }
      const liveSessionId = String(
        (body as Record<string, unknown>).liveSessionId || ''
      ).trim();
      if (!liveSessionId) throw new Error('invalid_collaboration_revoke');
      return send(res, 200, {
        revoked: await collaborationInviteStore.revokeSession(liveSessionId)
      });
    }

    const collaborationRouteSession = bearerToken(req) ? await authorize(req) : null;
    if (
      collaborationRouteSession?.collaboration &&
      !collaborationRouteAllowed(req.method, url.pathname)
    ) {
      return send(res, 403, { error: 'collaboration_scope_forbidden' });
    }

    if (req.method === 'GET' && url.pathname === '/capabilities') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { nodeId, providers: capabilityEngine.quickSnapshot() });
    }

    if (req.method === 'GET' && url.pathname === '/federation/providers') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const providers = capabilityEngine.quickSnapshot()
        .map(provider => {
          const descriptor = capabilityEngine.get(provider.providerId)?.descriptor;
          if (!descriptor || descriptor.nodeId !== nodeId) return null;
          return {
            ...provider,
            nodeId: descriptor.nodeId,
            displayName: descriptor.displayName,
            providerKey: descriptor.providerKey,
            kind: descriptor.kind,
            version: descriptor.version
          };
        })
        .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider));

      return send(res, 200, {
        nodeId,
        hostname: nodeDisplayName,
        providers
      });
    }

    if (req.method === 'GET' && url.pathname === '/signal-topology') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, {
        nodeId,
        topology: await signalTopologyStore.load()
      });
    }

    if (req.method === 'POST' && url.pathname === '/signal-topology') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const topology = await signalTopologyStore.replace(await readJson(req));
      return send(res, 200, { nodeId, topology });
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const state = await runtimeState.load();
      const providers = capabilityEngine.quickSnapshot().map(provider => {
        const descriptor = capabilityEngine.get(provider.providerId)?.descriptor;
        return {
          ...provider,
          displayName: descriptor?.displayName || provider.providerId,
          providerKey: descriptor?.providerKey || 'unknown',
          kind: descriptor?.kind || 'control',
          nodeId: descriptor?.nodeId || nodeId,
          observed:
            state.providerObservedState[provider.providerId] ||
            provider.observed ||
            {}
        };
      });
      const collaborationState = session.collaboration
        ? {
            ...state,
            activeLiveSessionId: session.collaboration.liveSessionId,
            requests: state.requests.filter(
              item => item.liveSessionId === session.collaboration!.liveSessionId
            )
          }
        : state;
      const liveDrop = session.binding && !session.collaboration
        ? await liveDropStore.list(liveDropScopeFromSession(session))
        : [];
      return send(res, 200, {
        nodeId,
        state: collaborationState,
        providers,
        routing: await providerRoutingStore.all(),
        peers: session.collaboration ? [] : peerFederation.publicStatus(),
        signalTopology: session.collaboration ? null : await signalTopologyStore.load(),
        liveDrop,
        ...(session.collaboration ? { collaboration: session.collaboration } : {})
      });
    }

    if (req.method === 'GET' && url.pathname === '/live-drop') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const scope = liveDropScopeFromSession(session);
      return send(res, 200, {
        assets: await liveDropStore.list(scope),
        maxBytes: LIVE_DROP_MAX_BYTES,
        retention: liveDropStore.retention
      });
    }

    if (req.method === 'POST' && url.pathname === '/live-drop/policy') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      liveDropScopeFromSession(session);

      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_live_drop_retention_policy');
      }
      const preset = String((body as Record<string, unknown>).preset || '');
      if (!['service', 'week', 'keep'].includes(preset)) {
        throw new Error('invalid_live_drop_retention_policy');
      }

      const retention = await liveDropStore.setRetentionPreset(
        preset as LiveDropRetentionPreset
      );
      return send(res, 200, {
        retention,
        preset
      });
    }

    if (req.method === 'POST' && url.pathname === '/live-drop') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const scope = liveDropScopeFromSession(session);
      const actorId = liveDropHeader(req, 'x-live-actor-id').trim();
      if (!actorId || actorId.length > 160) {
        throw new Error('invalid_live_drop_actor');
      }

      const declaredLength = Number(req.headers['content-length'] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > LIVE_DROP_MAX_BYTES) {
        throw new Error('live_drop_file_too_large');
      }

      const asset = await liveDropStore.upload({
        ...scope,
        nodeId,
        fileName: decodeLiveDropFileName(req),
        contentType: liveDropHeader(req, 'content-type'),
        uploadedBy: actorId
      }, req);

      return send(res, 201, { asset });
    }

    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/live-drop/') &&
      url.pathname.endsWith('/review')
    ) {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const scope = liveDropScopeFromSession(session);
      const parts = url.pathname.split('/').filter(Boolean);
      const assetId = decodeURIComponent(parts[1] || '');
      if (!assetId) throw new Error('invalid_live_drop_asset_id');

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_live_drop_review');
      const candidate = body as Record<string, unknown>;
      const status = String(candidate.status || '');
      const reviewedBy = String(candidate.reviewedBy || '').trim();
      if (!['ready', 'rejected'].includes(status) || !reviewedBy) {
        throw new Error('invalid_live_drop_review');
      }

      const asset = await liveDropStore.review(
        assetId,
        scope,
        status as 'ready' | 'rejected',
        reviewedBy
      );
      return send(res, 200, { asset });
    }

    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/live-drop/') &&
      url.pathname.endsWith('/open')
    ) {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const scope = liveDropScopeFromSession(session);
      const parts = url.pathname.split('/').filter(Boolean);
      const assetId = decodeURIComponent(parts[1] || '');
      if (!assetId) throw new Error('invalid_live_drop_asset_id');

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_live_drop_open');
      const candidate = body as Record<string, unknown>;
      const actorId = String(candidate.actorId || '').trim();
      const liveSessionId = String(candidate.liveSessionId || '').trim();
      const targetProviderId = String(candidate.providerId || '').trim();
      const serviceItemId = String(candidate.serviceItemId || '').trim();
      if (!actorId || !liveSessionId) throw new Error('invalid_live_drop_open');
      if (serviceItemId.length > 200) throw new Error('invalid_live_drop_service_item');

      const resolved = await liveDropStore.resolveReadyPath(assetId, scope);
      if (!['image', 'video', 'audio'].includes(resolved.asset.mediaType)) {
        return send(res, 409, { error: 'live_drop_media_open_not_supported' });
      }

      const mediaProviders = capabilityEngine.targetsFor('media.open');
      const configuredMediaProviderId = await providerRoutingStore.get('media');
      let selectedProviderId = targetProviderId;

      if (selectedProviderId) {
        const selectedProvider = capabilityEngine.get(selectedProviderId);
        if (!selectedProvider?.capabilities().has('media.open')) {
          return send(res, 409, { error: 'configured_provider_route_unavailable' });
        }
      } else if (
        configuredMediaProviderId &&
        mediaProviders.some(provider => provider.descriptor.id === configuredMediaProviderId)
      ) {
        selectedProviderId = configuredMediaProviderId;
      } else if (mediaProviders.length === 1) {
        selectedProviderId = mediaProviders[0]!.descriptor.id;
      } else if (mediaProviders.length > 1) {
        return send(res, 409, { error: 'ambiguous_provider_route' });
      } else {
        return send(res, 409, { error: 'no_provider_for_capability' });
      }

      const selectedProvider = capabilityEngine.get(selectedProviderId);
      if (!selectedProvider) {
        return send(res, 409, { error: 'configured_provider_route_unavailable' });
      }

      if (selectedProvider.descriptor.nodeId !== nodeId) {
        const peerNodeId = selectedProvider.descriptor.nodeId;
        const peer = await peerNodeStore.get(peerNodeId);
        if (!peer) {
          return send(res, 409, { error: 'peer_live_drop_target_not_paired' });
        }

        const federatedPrefix = `peer:${peerNodeId}:`;
        if (!selectedProviderId.startsWith(federatedPrefix)) {
          return send(res, 409, { error: 'peer_live_drop_provider_invalid' });
        }
        const remoteProviderId = selectedProviderId.slice(federatedPrefix.length);
        if (!remoteProviderId) {
          return send(res, 409, { error: 'peer_live_drop_provider_invalid' });
        }

        const federated = await stageAndOpenPeerLiveDrop({
          peer,
          localAsset: resolved.asset,
          localPath: resolved.path,
          remoteProviderId,
          federatedProviderId: selectedProviderId,
          actorId,
          liveSessionId,
          serviceItemId: serviceItemId || undefined
        });
        const accepted = federated.results.some(result => result.accepted);
        const failure = federated.results.find(result => !result.accepted);
        return send(res, accepted ? 200 : 409, {
          ...(accepted ? {} : { error: failure?.errorCode || 'provider_error' }),
          asset: resolved.asset,
          correlationId: federated.correlationId,
          results: federated.results,
          transfer: {
            mode: federated.reused ? 'reused' : 'replicated',
            targetNodeId: federated.targetNodeId
          }
        });
      }

      const commandId = randomUUID();
      const command: LiveCommand = {
        id: commandId,
        correlationId: randomUUID(),
        organizationId: scope.organizationId,
        venueId: scope.venueId,
        liveSystemId: scope.liveSystemId,
        liveSessionId,
        serviceItemId: serviceItemId || undefined,
        actorId,
        origin: 'live-ui',
        capability: 'media.open',
        targetProviderIds: [selectedProviderId],
        outputTargets: ['main'],
        payload: {
          kind: resolved.asset.mediaType,
          file: resolved.path,
          liveDropAssetId: resolved.asset.id
        },
        idempotencyKey: randomUUID(),
        createdAt: new Date().toISOString(),
        safetyLevel: 'normal'
      };

      const results = await execute(command);
      const accepted = results.some(result => result.accepted);
      const failure = results.find(result => !result.accepted);
      return send(res, accepted ? 200 : 409, {
        ...(accepted ? {} : { error: failure?.errorCode || 'provider_error' }),
        asset: resolved.asset,
        correlationId: command.correlationId,
        results,
        transfer: {
          mode: 'local',
          targetNodeId: nodeId
        }
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/provider-assets/')) {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const parts = url.pathname.split('/').filter(Boolean);
      const providerId = decodeURIComponent(parts[1] || '');
      const assetKind = parts[2] || '';
      const provider = capabilityEngine.get(providerId);
      if (!provider || !provider.fetchAsset) {
        return send(res, 404, { error: 'provider_asset_not_supported' });
      }

      if (!['output-snapshot', 'clip-thumbnail'].includes(assetKind)) {
        return send(res, 404, { error: 'provider_asset_kind_not_supported' });
      }

      const targetId = String(url.searchParams.get('targetId') || '');
      if (!targetId) return send(res, 400, { error: 'asset_target_required' });

      const request: ProviderAssetRequest = assetKind === 'clip-thumbnail'
        ? {
            kind: 'clip.thumbnail',
            targetId
          }
        : {
            kind: 'output.snapshot',
            targetId,
            format: url.searchParams.get('format') === 'png' ? 'png' : 'jpeg'
          };
      const asset = await provider.fetchAsset(request);
      return sendBinary(
        res,
        200,
        asset.contentType,
        asset.body,
        asset.cacheControl || 'no-store'
      );
    }

    if (req.method === 'POST' && url.pathname === '/heartbeat') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const binding = session.dev ? null : await pairingStore.touch(session.token);
      return send(res, 200, {
        nodeId,
        now: new Date().toISOString(),
        binding,
        stateRevision: (await runtimeState.load()).revision
      });
    }

    if (req.method === 'GET' && url.pathname === '/redundancy/status') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'redundancy_admin_required' });
      }
      const runtime = await runtimeState.load();
      const fleet = (await peerFederation.scopedFleet()).filter(peer =>
        peer.organizationId === session.binding!.organizationId &&
        peer.venueId === session.binding!.venueId &&
        peer.liveSystemId === session.binding!.liveSystemId
      );
      return send(res, 200, {
        local: {
          nodeId,
          displayName: nodeDisplayName,
          organizationId: session.binding.organizationId,
          venueId: session.binding.venueId,
          liveSystemId: session.binding.liveSystemId,
          servicePlanId: runtime.servicePlan?.id || null,
          servicePlanRevision: runtime.servicePlan?.revision || null,
          activeLiveSessionId: runtime.activeLiveSessionId
        },
        peers: fleet
      });
    }

    if (req.method === 'POST' && url.pathname === '/redundancy/prepare') {
      const session = await authorize(req);
      if (
        !session?.binding ||
        session.collaboration ||
        !session.binding.deviceId.startsWith('live-node:')
      ) {
        return send(res, 403, { error: 'redundancy_peer_required' });
      }

      const current = await runtimeState.load();
      if (current.activeLiveSessionId) {
        return send(res, 409, { error: 'redundancy_target_live_active' });
      }

      const body = await readJsonWithLimit(req, 1024 * 1024);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_redundancy_prepare');
      }
      const candidate = body as Record<string, unknown>;
      const plan = validateServicePlan(candidate.plan);
      const providerLinks = validateProviderLinks(candidate.providerLinks);
      const scenes = validateCachedScenes(candidate.scenes);
      assertServicePlanScope(plan, session.binding);
      assertProviderLinksScope(providerLinks, session.binding);
      assertCachedSceneScope(scenes, session.binding);

      const state = await runtimeState.patch({
        activeLiveSessionId: null,
        activeSession: null,
        activeServiceItemId: null,
        servicePlan: plan,
        providerLinks,
        scenes,
        requests: []
      });
      return send(res, 200, {
        nodeId,
        servicePlanId: plan.id,
        servicePlanRevision: plan.revision,
        providerLinks: providerLinks.length,
        scenes: scenes.length,
        stateRevision: state.revision
      });
    }

    if (req.method === 'POST' && url.pathname === '/redundancy/peer/prepare') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'redundancy_admin_required' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_redundancy_peer_prepare');
      }
      const remoteNodeId = String(
        (body as Record<string, unknown>).remoteNodeId || ''
      ).trim();
      if (!remoteNodeId) throw new Error('peer_node_id_required');

      const runtime = await runtimeState.load();
      if (!runtime.servicePlan) {
        return send(res, 409, { error: 'redundancy_service_plan_required' });
      }

      const prepared = await peerFederation.prepareStandby({
        remoteNodeId,
        plan: runtime.servicePlan,
        providerLinks: runtime.providerLinks,
        scenes: runtime.scenes
      });
      return send(res, 200, { prepared });
    }

    if (req.method === 'POST' && url.pathname === '/redundancy/peer/inspect') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'redundancy_admin_required' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_redundancy_peer_inspect');
      }
      const remoteNodeId = String(
        (body as Record<string, unknown>).remoteNodeId || ''
      ).trim();
      const local = await runtimeState.load();
      if (!local.servicePlan) {
        return send(res, 409, { error: 'redundancy_service_plan_required' });
      }

      const peer = await peerFederation.standbyStatus(remoteNodeId);
      const fleetPeer = (await peerFederation.scopedFleet())
        .find(item => item.nodeId === remoteNodeId);
      if (!fleetPeer) throw new Error('peer_not_paired');

      const decision = evaluateFailoverCandidate({
        source: {
          organizationId: session.binding.organizationId,
          venueId: session.binding.venueId,
          liveSystemId: session.binding.liveSystemId,
          servicePlanId: local.servicePlan.id,
          servicePlanRevision: local.servicePlan.revision
        },
        candidate: {
          nodeId: remoteNodeId,
          organizationId: fleetPeer.organizationId,
          venueId: fleetPeer.venueId,
          liveSystemId: fleetPeer.liveSystemId,
          health: fleetPeer.health,
          servicePlanId: peer.state.servicePlan?.id,
          servicePlanRevision: peer.state.servicePlan?.revision,
          lastSeenAt: fleetPeer.lastSeenAt
        },
        plan: local.servicePlan
      });

      return send(res, 200, {
        peer: {
          nodeId: remoteNodeId,
          servicePlanId: peer.state.servicePlan?.id || null,
          servicePlanRevision: peer.state.servicePlan?.revision || null,
          activeLiveSessionId: peer.state.activeLiveSessionId
        },
        decision
      });
    }

    if (req.method === 'POST' && url.pathname === '/redundancy/activate') {
      const session = await authorize(req);
      if (!session?.binding || session.collaboration) {
        return send(res, 403, { error: 'redundancy_admin_required' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object') {
        throw new Error('invalid_redundancy_activation');
      }
      const candidate = body as Record<string, unknown>;
      if (candidate.confirmed !== true) {
        return send(res, 409, { error: 'redundancy_activation_confirmation_required' });
      }

      const expectedPlanId = String(candidate.servicePlanId || '').trim();
      const expectedRevision = Number(candidate.servicePlanRevision);
      const previousNodeId = String(candidate.previousNodeId || '').trim();
      if (!expectedPlanId || !Number.isInteger(expectedRevision) || !previousNodeId) {
        throw new Error('invalid_redundancy_activation');
      }
      if (previousNodeId === nodeId) {
        throw new Error('redundancy_previous_node_invalid');
      }

      const runtime = await runtimeState.load();
      if (runtime.activeLiveSessionId) {
        return send(res, 409, { error: 'redundancy_target_live_active' });
      }
      if (
        !runtime.servicePlan ||
        runtime.servicePlan.id !== expectedPlanId ||
        runtime.servicePlan.revision !== expectedRevision
      ) {
        return send(res, 409, { error: 'redundancy_plan_mismatch' });
      }

      const activatedAt = new Date().toISOString();
      const liveSessionId = `failover:${runtime.servicePlan.id}:${Date.now()}`;
      const commandNamespace = `failover:${runtime.servicePlan.id}:r${runtime.servicePlan.revision}`;
      const state = await runtimeState.patch({
        activeLiveSessionId: liveSessionId,
        activeSession: {
          id: liveSessionId,
          mode: 'service',
          label: `Failover de ${previousNodeId}`,
          servicePlanId: runtime.servicePlan.id,
          activatedAt,
          activatedBy: String(candidate.actorId || 'operator')
        },
        activeServiceItemId: runtime.servicePlan.items[0]?.id || null
      });

      return send(res, 200, {
        activated: true,
        nodeId,
        liveSessionId,
        servicePlanId: runtime.servicePlan.id,
        servicePlanRevision: runtime.servicePlan.revision,
        commandNamespace,
        sampleIdempotencyKey: failoverIdempotencyKey({
          namespace: commandNamespace,
          originalIdempotencyKey: 'next-command'
        }),
        stateRevision: state.revision,
        automaticCommandSent: false
      });
    }

    if (req.method === 'POST' && url.pathname === '/service-plan') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      const wrapper = (
        body &&
        typeof body === 'object' &&
        'plan' in (body as Record<string, unknown>)
      )
        ? body as Record<string, unknown>
        : { plan: body, providerLinks: [] };

      const plan = validateServicePlan(wrapper.plan);
      const providerLinks = validateProviderLinks(wrapper.providerLinks);
      assertServicePlanScope(plan, session.binding);
      assertProviderLinksScope(providerLinks, session.binding);

      const currentRuntime = await runtimeState.load();
      if (
        currentRuntime.servicePlan?.id === plan.id &&
        plan.revision < currentRuntime.servicePlan.revision
      ) {
        return send(res, 409, {
          error: 'stale_service_plan',
          currentRevision: currentRuntime.servicePlan.revision,
          incomingRevision: plan.revision
        });
      }

      const samePlan = currentRuntime.servicePlan?.id === plan.id;
      const preservedActiveItemId =
        samePlan &&
        currentRuntime.activeServiceItemId &&
        plan.items.some(item => item.id === currentRuntime.activeServiceItemId)
          ? currentRuntime.activeServiceItemId
          : plan.items[0]?.id || null;
      const state = await runtimeState.patch({
        servicePlan: plan,
        providerLinks,
        activeLiveSessionId:
          samePlan && currentRuntime.activeLiveSessionId
            ? currentRuntime.activeLiveSessionId
            : `service-plan:${plan.id}`,
        activeServiceItemId: preservedActiveItemId
      });
      return send(res, 200, {
        nodeId,
        servicePlanId: plan.id,
        providerLinks: providerLinks.length,
        stateRevision: state.revision
      });
    }

    if (req.method === 'POST' && url.pathname === '/pairing/revoke') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_revoke_request');
      const deviceId = String((body as Record<string, unknown>).deviceId || '');
      if (!deviceId) throw new Error('invalid_revoke_request');
      if (session.binding && session.binding.deviceId !== deviceId) {
        return send(res, 403, { error: 'cannot_revoke_other_device' });
      }
      return send(res, 200, { revoked: await pairingStore.revoke(deviceId) });
    }

    if (req.method === 'POST' && url.pathname === '/scenes/cache') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_scenes_cache');
      const scenes = validateCachedScenes((body as Record<string, unknown>).scenes);
      assertCachedSceneScope(scenes, session.binding);

      const next = await runtimeState.patch({ scenes });
      return send(res, 200, {
        nodeId,
        scenes: scenes.length,
        stateRevision: next.revision
      });
    }

    if (req.method === 'GET' && url.pathname === '/chat') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      if (!session.binding) return send(res, 403, { error: 'pairing_scope_required' });

      const liveSessionId = String(url.searchParams.get('liveSessionId') || '').trim();
      if (!liveSessionId) throw new Error('invalid_live_chat_session');
      if (
        session.collaboration &&
        liveSessionId !== session.collaboration.liveSessionId
      ) {
        return send(res, 403, { error: 'collaboration_scope_forbidden' });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || '100');
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(300, Math.floor(requestedLimit)))
        : 100;

      const messages = await liveChatStore.list({
        organizationId: session.binding.organizationId,
        venueId: session.binding.venueId,
        liveSystemId: session.binding.liveSystemId,
        liveSessionId,
        limit
      });
      return send(res, 200, { messages });
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const message = validateLiveChatMessage(await readJson(req));
      assertLiveChatScope(message, session.binding);
      if (session.collaboration) {
        const expectedSender =
          session.collaboration.role === 'pastor'
            ? 'pastor'
            : session.collaboration.role === 'conductor'
              ? 'conductor'
              : 'team';
        if (
          !session.collaboration.permissions.includes('chat.write') ||
          message.liveSessionId !== session.collaboration.liveSessionId ||
          message.actorId !== session.collaboration.actorId ||
          message.senderContext !== expectedSender
        ) {
          return send(res, 403, { error: 'collaboration_scope_forbidden' });
        }
      }
      await liveChatStore.append(message);
      return send(res, 201, { message });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      if (!session.binding) return send(res, 403, { error: 'pairing_scope_required' });

      const liveSessionId = String(url.searchParams.get('liveSessionId') || '').trim();
      const requestedLimit = Number(url.searchParams.get('limit') || '80');
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(250, Math.floor(requestedLimit)))
        : 80;
      const scope = {
        organizationId: session.binding.organizationId,
        venueId: session.binding.venueId,
        liveSystemId: session.binding.liveSystemId,
        ...(liveSessionId ? { liveSessionId } : {})
      };
      const [events, summary] = await Promise.all([
        eventLogStore.list({ ...scope, limit }),
        eventLogStore.summarize(scope)
      ]);
      return send(res, 200, {
        events,
        total: summary.total,
        summary,
        ...(liveSessionId ? { liveSessionId } : {})
      });
    }

    if (req.method === 'GET' && url.pathname === '/requests') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });
      const state = await runtimeState.load();
      const requestedSessionId = String(url.searchParams.get('liveSessionId') || '');
      if (
        session.collaboration &&
        requestedSessionId &&
        requestedSessionId !== session.collaboration.liveSessionId
      ) {
        return send(res, 403, { error: 'collaboration_scope_forbidden' });
      }
      const liveSessionId = session.collaboration?.liveSessionId || requestedSessionId;
      const requests = state.requests
        .filter(item => !liveSessionId || item.liveSessionId === liveSessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { requests });
    }

    if (req.method === 'POST' && url.pathname === '/requests') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const request = validateLiveRequest(await readJson(req));
      assertLiveRequestScope(request, session.binding);
      if (
        session.collaboration &&
        !collaborationCanRequest(session.collaboration, request)
      ) {
        return send(res, 403, { error: 'collaboration_scope_forbidden' });
      }

      const state = await runtimeState.load();
      const existing = state.requests.find(item => item.id === request.id);
      if (existing) return send(res, 200, { request: existing, stateRevision: state.revision });

      const nextRequests = [request, ...state.requests]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200);
      const next = await runtimeState.patch({ requests: nextRequests });
      const requestLiveSystemId =
        session.binding?.liveSystemId ||
        next.servicePlan?.liveSystemId ||
        '';
      await eventLogStore
        .append(eventFromRequestCreated(request, requestLiveSystemId))
        .catch(() => undefined);
      return send(res, 201, { request, stateRevision: next.revision });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/requests/') && url.pathname.endsWith('/status')) {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const parts = url.pathname.split('/').filter(Boolean);
      const requestId = decodeURIComponent(parts[1] || '');
      if (!requestId) throw new Error('invalid_live_request_id');

      const body = await readJson(req);
      if (!body || typeof body !== 'object') throw new Error('invalid_live_request_status');
      const candidate = body as Record<string, unknown>;
      const status = String(candidate.status || '') as LiveRequestStatus;
      if (!['seen','accepted','prepared','executed','rejected'].includes(status)) {
        throw new Error('invalid_live_request_status');
      }
      const resolvedBy = String(candidate.resolvedBy || '');
      if (!resolvedBy) throw new Error('invalid_live_request_resolver');

      const state = await runtimeState.load();
      const current = state.requests.find(item => item.id === requestId);
      if (!current) return send(res, 404, { error: 'live_request_not_found' });
      assertLiveRequestScope(current, session.binding);
      if (
        session.collaboration &&
        (
          status !== 'rejected' ||
          current.actorId !== session.collaboration.actorId ||
          current.liveSessionId !== session.collaboration.liveSessionId ||
          resolvedBy !== session.collaboration.actorId
        )
      ) {
        return send(res, 403, { error: 'collaboration_scope_forbidden' });
      }

      const now = new Date().toISOString();
      let transitioned: LiveRequest;
      try {
        transitioned = transitionLiveRequest(current, status, resolvedBy, now);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'invalid_live_request_transition';
        return send(res, 409, { error: code });
      }
      const requests = state.requests.map(item =>
        item.id === requestId ? transitioned : item
      );
      const next = await runtimeState.patch({ requests });
      const updatedRequest = requests.find(item => item.id === requestId);
      if (updatedRequest) {
        const requestLiveSystemId =
          session.binding?.liveSystemId ||
          next.servicePlan?.liveSystemId ||
          '';
        await eventLogStore
          .append(eventFromRequestStatus(updatedRequest, requestLiveSystemId))
          .catch(() => undefined);
      }
      return send(res, 200, {
        request: updatedRequest,
        stateRevision: next.revision
      });
    }

    if (req.method === 'POST' && url.pathname === '/scenes/execute') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const sceneRequest = validateSceneExecutionRequest(await readJson(req));
      assertSceneScope(sceneRequest, session.binding);

      const cached = sceneIdempotency.get(sceneRequest.idempotencyKey);
      if (cached) return send(res, 200, cached);

      const safetyLevels = sceneRequest.scene.actions.map(action => action.safetyLevel);
      if (
        safetyLevels.includes('critical') &&
        liveEnv('CRITICAL_ACTIONS_ENABLED') !== 'true'
      ) {
        return send(res, 403, { error: 'critical_action_blocked' });
      }
      if (
        safetyLevels.some(level => level === 'guarded' || level === 'critical') &&
        req.headers['x-live-confirmation'] !== sceneRequest.id
      ) {
        return send(res, 409, { error: 'guarded_action_confirmation_required' });
      }

      const result = await sceneIdempotency.run(
        sceneRequest.idempotencyKey,
        async () => {
          const execution = await sceneExecutor.execute(sceneRequest);
          await eventLogStore
            .append(eventFromScene(sceneRequest, execution))
            .catch(() => undefined);
          return execution;
        }
      );
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/commands') {
      const session = await authorize(req);
      if (!session) return send(res, 401, { error: 'unauthorized' });

      const command = validateCommand(await readJson(req));
      assertCommandScope(command, session.binding);
      if (session.collaboration) {
        const allowedCapability =
          (
            command.capability === 'bible.search' &&
            session.collaboration.permissions.includes('request.bible')
          ) ||
          (
            command.capability === 'songs.search' &&
            session.collaboration.permissions.includes('request.song')
          );
        if (
          !allowedCapability ||
          command.liveSessionId !== session.collaboration.liveSessionId ||
          command.actorId !== session.collaboration.actorId
        ) {
          return send(res, 403, { error: 'collaboration_command_forbidden' });
        }
      }

      if (command.safetyLevel === 'critical' && liveEnv('CRITICAL_ACTIONS_ENABLED') !== 'true') {
        return send(res, 403, { error: 'critical_action_blocked' });
      }
      if (
        command.safetyLevel === 'guarded' &&
        req.headers['x-live-confirmation'] !== command.id
      ) {
        return send(res, 409, { error: 'guarded_action_confirmation_required' });
      }

      return send(res, 200, {
        correlationId: command.correlationId,
        results: await execute(command)
      });
    }

    if (req.method === 'GET' && await serveWebApp(res, url.pathname)) {
      return;
    }

    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'internal_error';
    const status =
      message === 'payload_too_large' || message === 'live_drop_file_too_large' ? 413 :
      message === 'forbidden_scope' ||
      message === 'live_drop_pairing_scope_required' ||
      message === 'collaboration_scope_forbidden' ||
      message === 'collaboration_command_forbidden' ||
      message === 'collaboration_invite_admin_required' ? 403 :
      message === 'live_drop_asset_not_found' ? 404 :
      message === 'live_drop_file_type_not_allowed' || message === 'live_drop_content_type_mismatch' ? 415 :
      message === 'provider_link_target_missing' ? 409 :
      message === 'collaboration_session_not_active' ||
      message === 'collaboration_invite_exhausted' ? 409 :
      message === 'stale_service_plan' ? 409 :
      message === 'idempotency_previous_attempt_uncertain' ? 409 :
      message === 'live_drop_asset_not_ready' ||
      message === 'live_drop_asset_not_quarantined' ||
      message === 'live_drop_media_open_not_supported' ||
      message.startsWith('peer_live_drop_') ? 409 :
      message.includes('expired') ? 410 :
      message.includes('attempts_exceeded') ? 429 :
      message.includes('pin_invalid') || message.startsWith('invalid_') || message.startsWith('signal_') || message.startsWith('duplicate_signal_') || message.startsWith('live_drop_') ? 400 :
      500;
    return send(res, status, { error: message });
  }
});

  server.listen(PORT, HOST, () => {
    const urls = lanAddresses().map(ip => `http://${ip}:${PORT}`);
    console.log(JSON.stringify({
      event: 'live_node_started',
      nodeId,
      version: VERSION,
      local: `http://127.0.0.1:${PORT}`,
      lan: urls,
      stateDir: STATE_DIR,
      webRoot: WEB_ROOT,
      pairingEnabled: PAIRING_ENABLED
    }));
  });

  const providerObservationTimer = setInterval(() => {
    observeOnlineProviders();
  }, 100);
  providerObservationTimer.unref();

  const providerRecoveryTimer = setInterval(() => {
    void recoverUnhealthyProviders();
  }, 10_000);
  providerRecoveryTimer.unref();

  const peerRefreshTimer = setInterval(() => {
    void peerFederation.refreshAll();
  }, 2_000);
  peerRefreshTimer.unref();
}

void start().catch(error => {
  console.error(JSON.stringify({
    event: 'live_node_fatal',
    error: error instanceof Error ? error.message : 'unknown'
  }));
  process.exitCode = 1;
});
