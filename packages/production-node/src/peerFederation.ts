import {
  CAPABILITIES,
  CapabilityEngine,
  type Capability,
  type PairingChallenge,
  type PairingCompleteResponse,
  type ProviderHealth,
  type ProviderKind,
  type ProviderLink,
  type Scene,
  type ServicePlan,
  type LiveNodeRuntimeState
} from '@millionsnest/nestlive-production-domain';
import { FederatedProviderAdapter, fetchPeerProviders, makeFederatedProviderId, type PeerProviderSnapshot } from './federatedProvider';
import { normalizeLanPeerUrl } from './networkPolicy';
import { PeerNodeStore, type PeerNodeRecord } from './peerNodeStore';

type FetchLike = typeof fetch;

const PROVIDER_KINDS = new Set<ProviderKind>([
  'presentation',
  'bible',
  'visual',
  'broadcast',
  'stage',
  'audio',
  'control'
]);

const PROVIDER_HEALTH = new Set<ProviderHealth>([
  'online',
  'degraded',
  'reconnecting',
  'offline',
  'manual'
]);

interface PeerDiscovery {
  product: string;
  protocolVersion: number;
  version: string;
  nodeId: string;
  hostname?: string;
  port: number;
}

interface PendingPeerPairing {
  remoteNodeId: string;
  baseUrl: string;
  challengeId: string;
  deviceId: string;
  deviceName: string;
  expiresAt: string;
  remoteDisplayName: string;
}

export interface PeerFederationStatus {
  nodeId: string;
  displayName: string;
  baseUrl: string;
  health: 'online' | 'degraded' | 'offline';
  providers: number;
  providersOnline: number;
  lastSeenAt?: string;
}

export interface PeerPairingRequest {
  baseUrl: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
}

export interface PeerPairingChallenge {
  remoteNodeId: string;
  baseUrl: string;
  challengeId: string;
  expiresAt: string;
  method: 'pin';
  displayedOnRemoteNode: true;
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 3500
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code =
        body && typeof body === 'object' && 'error' in body
          ? String((body as Record<string, unknown>).error || 'peer_request_failed')
          : 'peer_request_failed';
      throw new Error(code);
    }
    return body as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverPeerNode(
  fetchImpl: FetchLike,
  baseUrl: string
): Promise<PeerDiscovery> {
  let lastError: unknown = null;
  for (const path of [
    '/.well-known/nestlive-node',
    '/.well-known/millionsnest-live-node'
  ]) {
    try {
      const discovery = await fetchJson<PeerDiscovery>(
        fetchImpl,
        `${baseUrl}${path}`,
        {},
        2500
      );
      if (
        (discovery.product === 'NestLive Node' ||
          discovery.product === 'MillionsNest Live Node') &&
        discovery.nodeId &&
        discovery.protocolVersion === 1
      ) {
        return discovery;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('peer_not_musicscale_live_node');
}

function sanitizeProviderSnapshot(
  value: PeerProviderSnapshot,
  expectedNodeId: string
): PeerProviderSnapshot | null {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.providerId !== 'string' ||
    !value.providerId ||
    value.nodeId !== expectedNodeId ||
    typeof value.displayName !== 'string' ||
    typeof value.providerKey !== 'string' ||
    !PROVIDER_KINDS.has(value.kind) ||
    !PROVIDER_HEALTH.has(value.health) ||
    !Array.isArray(value.capabilities)
  ) {
    return null;
  }

  const capabilities = value.capabilities.filter(
    (capability): capability is Capability =>
      typeof capability === 'string' &&
      (CAPABILITIES as readonly string[]).includes(capability)
  );

  return {
    ...value,
    capabilities,
    observed:
      value.observed && typeof value.observed === 'object' && !Array.isArray(value.observed)
        ? value.observed
        : {}
  };
}

export interface PeerStandbyPreparation {
  nodeId: string;
  servicePlanId: string;
  servicePlanRevision: number;
  scenes: number;
  providerLinks: number;
  stateRevision: number;
}

export interface PeerStandbyStatus {
  nodeId: string;
  state: LiveNodeRuntimeState;
}

export class PeerFederation {
  private readonly adapters = new Map<string, FederatedProviderAdapter>();
  private readonly statuses = new Map<string, PeerFederationStatus>();
  private readonly pendingPairings = new Map<string, PendingPeerPairing>();
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private readonly options: {
      localNodeId: string;
      localDisplayName: string;
      capabilityEngine: CapabilityEngine;
      store: PeerNodeStore;
      fetchImpl?: FetchLike;
    }
  ) {}

  private get fetchImpl(): FetchLike {
    return this.options.fetchImpl || fetch;
  }

  setLocalDisplayName(displayName: string): void {
    const normalized = displayName.trim().replace(/\s+/g, ' ').slice(0, 64);
    if (normalized) this.options.localDisplayName = normalized;
  }

  async load(): Promise<void> {
    await this.options.store.load();
    const peers = await this.options.store.all();
    for (const peer of peers) {
      this.statuses.set(peer.nodeId, {
        nodeId: peer.nodeId,
        displayName: peer.displayName,
        baseUrl: peer.baseUrl,
        health: 'offline',
        providers: 0,
        providersOnline: 0,
        lastSeenAt: peer.lastSeenAt
      });
    }
    await this.refreshAll();
  }

  async requestPairing(request: PeerPairingRequest): Promise<PeerPairingChallenge> {
    for (const value of [
      request.organizationId,
      request.venueId,
      request.liveSystemId
    ]) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error('peer_pairing_scope_required');
      }
    }

    const baseUrl = normalizeLanPeerUrl(request.baseUrl);
    const discovery = await discoverPeerNode(this.fetchImpl, baseUrl);
    if (discovery.nodeId === this.options.localNodeId) {
      throw new Error('peer_cannot_be_self');
    }

    const deviceId = `live-node:${this.options.localNodeId}`;
    const deviceName = `NestLive Node · ${this.options.localDisplayName}`;
    const challenge = await fetchJson<PairingChallenge>(
      this.fetchImpl,
      `${baseUrl}/pairing/request`,
      {
        method: 'POST',
        body: JSON.stringify({
          organizationId: request.organizationId,
          venueId: request.venueId,
          liveSystemId: request.liveSystemId,
          deviceId,
          deviceName
        })
      },
      3500
    );

    if (challenge.nodeId !== discovery.nodeId) {
      throw new Error('peer_node_identity_mismatch');
    }

    this.pendingPairings.set(discovery.nodeId, {
      remoteNodeId: discovery.nodeId,
      baseUrl,
      challengeId: challenge.challengeId,
      deviceId,
      deviceName,
      expiresAt: challenge.expiresAt,
      remoteDisplayName: discovery.hostname || discovery.nodeId
    });

    return {
      remoteNodeId: discovery.nodeId,
      baseUrl,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      method: 'pin',
      displayedOnRemoteNode: true
    };
  }

  async completePairing(
    remoteNodeId: string,
    pin: string
  ): Promise<PeerFederationStatus> {
    const pending = this.pendingPairings.get(remoteNodeId);
    if (!pending) throw new Error('peer_pairing_not_pending');
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingPairings.delete(remoteNodeId);
      throw new Error('peer_pairing_challenge_expired');
    }
    if (!/^\d{6}$/.test(pin)) throw new Error('peer_pairing_pin_invalid');

    const completed = await fetchJson<PairingCompleteResponse>(
      this.fetchImpl,
      `${pending.baseUrl}/pairing/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          challengeId: pending.challengeId,
          pin,
          deviceId: pending.deviceId,
          deviceName: pending.deviceName
        })
      },
      3500
    );

    if (
      completed.nodeId !== remoteNodeId ||
      completed.binding.nodeId !== remoteNodeId
    ) {
      throw new Error('peer_node_identity_mismatch');
    }

    const peer: PeerNodeRecord = {
      nodeId: remoteNodeId,
      baseUrl: pending.baseUrl,
      token: completed.token,
      displayName: pending.remoteDisplayName,
      organizationId: completed.binding.organizationId,
      venueId: completed.binding.venueId,
      liveSystemId: completed.binding.liveSystemId,
      pairedAt: completed.binding.pairedAt,
      lastSeenAt: new Date().toISOString()
    };

    await this.options.store.upsert(peer);
    this.pendingPairings.delete(remoteNodeId);
    await this.refreshPeer(peer);

    return this.statuses.get(remoteNodeId) || {
      nodeId: remoteNodeId,
      displayName: peer.displayName,
      baseUrl: peer.baseUrl,
      health: 'offline',
      providers: 0,
      providersOnline: 0
    };
  }

  async refreshAll(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      const peers = await this.options.store.all();
      const activeIds = new Set(peers.map(peer => peer.nodeId));

      for (const nodeId of [...this.statuses.keys()]) {
        if (!activeIds.has(nodeId)) this.statuses.delete(nodeId);
      }

      await Promise.allSettled(peers.map(peer => this.refreshPeer(peer)));
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async removePeer(nodeId: string): Promise<boolean> {
    const peer = await this.options.store.get(nodeId);
    if (!peer) return false;

    // Best-effort remote revocation: removing a computer should invalidate the
    // Node-to-Node token on the other side as well, while remaining removable
    // locally if that computer is currently offline.
    await fetchJson(
      this.fetchImpl,
      `${peer.baseUrl}/pairing/revoke`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${peer.token}` },
        body: JSON.stringify({
          deviceId: `live-node:${this.options.localNodeId}`
        })
      },
      3000
    ).catch(() => null);

    const removed = await this.options.store.remove(nodeId);
    this.pendingPairings.delete(nodeId);
    this.statuses.delete(nodeId);

    for (const [providerId, adapter] of this.adapters) {
      if (adapter.peerNodeId !== nodeId) continue;
      this.options.capabilityEngine.unregister(providerId);
      this.adapters.delete(providerId);
    }

    return removed;
  }

  async prepareStandby(input: {
    remoteNodeId: string;
    plan: ServicePlan;
    providerLinks: ProviderLink[];
    scenes: Scene[];
  }): Promise<PeerStandbyPreparation> {
    const peer = await this.options.store.get(input.remoteNodeId);
    if (!peer) throw new Error('peer_not_paired');
    if (
      input.plan.organizationId !== peer.organizationId ||
      input.plan.venueId !== peer.venueId ||
      input.plan.liveSystemId !== peer.liveSystemId
    ) {
      throw new Error('peer_standby_scope_forbidden');
    }

    return fetchJson<PeerStandbyPreparation>(
      this.fetchImpl,
      `${peer.baseUrl}/redundancy/prepare`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${peer.token}` },
        body: JSON.stringify({
          plan: input.plan,
          providerLinks: input.providerLinks,
          scenes: input.scenes,
          sourceNodeId: this.options.localNodeId
        })
      },
      8000
    );
  }

  async standbyStatus(remoteNodeId: string): Promise<PeerStandbyStatus> {
    const peer = await this.options.store.get(remoteNodeId);
    if (!peer) throw new Error('peer_not_paired');

    const response = await fetchJson<{
      nodeId: string;
      state: LiveNodeRuntimeState;
    }>(
      this.fetchImpl,
      `${peer.baseUrl}/state`,
      {
        headers: { Authorization: `Bearer ${peer.token}` }
      },
      4000
    );
    if (response.nodeId !== remoteNodeId) {
      throw new Error('peer_node_identity_mismatch');
    }
    return response;
  }

  async scopedFleet(): Promise<Array<{
    nodeId: string;
    displayName: string;
    organizationId: string;
    venueId: string;
    liveSystemId: string;
    health: PeerFederationStatus['health'];
    providers: number;
    providersOnline: number;
    lastSeenAt?: string;
  }>> {
    const peers = await this.options.store.all();
    return peers.map(peer => {
      const status = this.statuses.get(peer.nodeId);
      return {
        nodeId: peer.nodeId,
        displayName: status?.displayName || peer.displayName,
        organizationId: peer.organizationId,
        venueId: peer.venueId,
        liveSystemId: peer.liveSystemId,
        health: status?.health || 'offline',
        providers: status?.providers || 0,
        providersOnline: status?.providersOnline || 0,
        lastSeenAt: status?.lastSeenAt || peer.lastSeenAt
      };
    });
  }

  publicStatus(): PeerFederationStatus[] {
    return [...this.statuses.values()]
      .map(status => ({ ...status }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private async refreshPeer(peer: PeerNodeRecord): Promise<void> {
    try {
      const response = await fetchPeerProviders(peer, this.fetchImpl);
      if (response.nodeId !== peer.nodeId) {
        throw new Error('peer_node_identity_mismatch');
      }

      const snapshots = response.providers
        .map(provider => sanitizeProviderSnapshot(provider, peer.nodeId))
        .filter((provider): provider is PeerProviderSnapshot => Boolean(provider));

      const seen = new Set<string>();
      for (const snapshot of snapshots) {
        const providerId = makeFederatedProviderId(peer.nodeId, snapshot.providerId);
        seen.add(providerId);

        const existing = this.adapters.get(providerId);
        if (existing) {
          existing.refresh(
            { ...peer, displayName: response.hostname || peer.displayName },
            snapshot
          );
        } else {
          const adapter = new FederatedProviderAdapter(
            { ...peer, displayName: response.hostname || peer.displayName },
            snapshot,
            this.fetchImpl
          );
          this.options.capabilityEngine.register(adapter);
          this.adapters.set(providerId, adapter);
        }
      }

      for (const [providerId, adapter] of this.adapters) {
        if (adapter.peerNodeId !== peer.nodeId || seen.has(providerId)) continue;
        this.options.capabilityEngine.unregister(providerId);
        this.adapters.delete(providerId);
      }

      const now = new Date().toISOString();
      const providersOnline = snapshots.filter(provider =>
        provider.health === 'online' || provider.health === 'degraded'
      ).length;
      const health: PeerFederationStatus['health'] =
        snapshots.length === 0 || snapshots.some(provider => provider.health !== 'online')
          ? 'degraded'
          : 'online';

      this.statuses.set(peer.nodeId, {
        nodeId: peer.nodeId,
        displayName: response.hostname || peer.displayName,
        baseUrl: peer.baseUrl,
        health,
        providers: snapshots.length,
        providersOnline,
        lastSeenAt: now
      });
    } catch {
      for (const adapter of this.adapters.values()) {
        if (adapter.peerNodeId === peer.nodeId) adapter.markPeerOffline();
      }
      const previous = this.statuses.get(peer.nodeId);
      this.statuses.set(peer.nodeId, {
        nodeId: peer.nodeId,
        displayName: previous?.displayName || peer.displayName,
        baseUrl: peer.baseUrl,
        health: 'offline',
        providers: previous?.providers || 0,
        providersOnline: 0,
        lastSeenAt: previous?.lastSeenAt
      });
    }
  }
}
