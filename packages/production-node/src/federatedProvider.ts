import type {
  Capability,
  CommandResult,
  LiveCommand,
  ProviderAdapter,
  ProviderAsset,
  ProviderAssetRequest,
  ProviderHealth,
  ProviderKind,
  ProviderProbeResult,
  ProviderState
} from '@millionsnest/nestlive-production-domain';
import type { PeerNodeRecord } from './peerNodeStore';

export interface PeerProviderSnapshot {
  providerId: string;
  nodeId: string;
  displayName: string;
  providerKey: string;
  kind: ProviderKind;
  version?: string;
  capabilities: Capability[];
  health: ProviderHealth;
  observed?: Record<string, unknown>;
}

export interface PeerProvidersResponse {
  nodeId: string;
  hostname: string;
  providers: PeerProviderSnapshot[];
}

type FetchLike = typeof fetch;

function federatedProviderId(peerNodeId: string, remoteProviderId: string): string {
  return `peer:${peerNodeId}:${remoteProviderId}`;
}

async function withTimeout(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  peer: Pick<PeerNodeRecord, 'baseUrl' | 'token'>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 3500
): Promise<T> {
  const response = await withTimeout(
    fetchImpl,
    `${peer.baseUrl}${path}`,
    {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${peer.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    },
    timeoutMs
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code =
      body && typeof body === 'object' && 'error' in body
        ? String((body as Record<string, unknown>).error || 'peer_request_failed')
        : 'peer_request_failed';
    throw new Error(code);
  }
  return body as T;
}

export async function fetchPeerProviders(
  peer: Pick<PeerNodeRecord, 'baseUrl' | 'token'>,
  fetchImpl: FetchLike = fetch
): Promise<PeerProvidersResponse> {
  return requestJson<PeerProvidersResponse>(
    fetchImpl,
    peer,
    '/federation/providers',
    {},
    3000
  );
}

export class FederatedProviderAdapter implements ProviderAdapter {
  readonly descriptor;
  readonly observationIntervalMs = 1500;

  private readonly capabilitiesSet = new Set<Capability>();
  private state: ProviderState;
  private remoteVersion?: string;

  constructor(
    private peer: PeerNodeRecord,
    private snapshot: PeerProviderSnapshot,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.descriptor = {
      id: federatedProviderId(peer.nodeId, snapshot.providerId),
      nodeId: peer.nodeId,
      kind: snapshot.kind,
      displayName: `${snapshot.displayName} · ${peer.displayName}`,
      providerKey: snapshot.providerKey,
      version: snapshot.version
    };
    this.remoteVersion = snapshot.version;
    this.state = {
      health: snapshot.health,
      updatedAt: new Date().toISOString(),
      observed: snapshot.observed || {}
    };
    this.replaceCapabilities(snapshot.capabilities);
  }

  get remoteProviderId(): string {
    return this.snapshot.providerId;
  }

  get peerNodeId(): string {
    return this.peer.nodeId;
  }

  refresh(peer: PeerNodeRecord, snapshot: PeerProviderSnapshot): void {
    this.peer = peer;
    this.snapshot = snapshot;
    this.remoteVersion = snapshot.version;
    this.replaceCapabilities(snapshot.capabilities);
    this.state = {
      health: snapshot.health,
      updatedAt: new Date().toISOString(),
      observed: snapshot.observed || {}
    };
  }

  markPeerOffline(): void {
    this.state = {
      ...this.state,
      health: 'offline',
      updatedAt: new Date().toISOString()
    };
  }

  capabilities(): ReadonlySet<Capability> {
    return this.capabilitiesSet;
  }

  peekState(): ProviderState {
    return structuredClone(this.state);
  }

  async probe(): Promise<ProviderProbeResult> {
    try {
      const response = await fetchPeerProviders(this.peer, this.fetchImpl);
      if (response.nodeId !== this.peer.nodeId) {
        this.markPeerOffline();
        return {
          reachable: false,
          capabilities: [...this.capabilitiesSet],
          reason: 'peer_node_identity_mismatch'
        };
      }

      const snapshot = response.providers.find(
        provider => provider.providerId === this.remoteProviderId
      );
      if (!snapshot) {
        this.markPeerOffline();
        return {
          reachable: false,
          capabilities: [...this.capabilitiesSet],
          reason: 'peer_provider_missing'
        };
      }

      this.refresh(this.peer, snapshot);
      return {
        reachable: snapshot.health !== 'offline',
        version: this.remoteVersion,
        capabilities: [...this.capabilitiesSet],
        reason: snapshot.health === 'offline' ? 'peer_provider_offline' : undefined
      };
    } catch (error) {
      this.markPeerOffline();
      return {
        reachable: false,
        capabilities: [...this.capabilitiesSet],
        reason: error instanceof Error ? error.message : 'peer_unreachable'
      };
    }
  }

  async getState(): Promise<ProviderState> {
    await this.probe();
    return this.peekState();
  }

  async execute(command: LiveCommand): Promise<CommandResult> {
    const startedAt = Date.now();
    try {
      const translated: LiveCommand = {
        ...command,
        targetProviderIds: [this.remoteProviderId]
      };

      const guardedHeaders: Record<string, string> =
        command.safetyLevel === 'guarded' || command.safetyLevel === 'critical'
          ? { 'x-live-confirmation': command.id }
          : {};

      const response = await requestJson<{
        correlationId: string;
        results: CommandResult[];
      }>(
        this.fetchImpl,
        this.peer,
        '/commands',
        {
          method: 'POST',
          headers: guardedHeaders,
          body: JSON.stringify(translated)
        },
        6000
      );

      const remoteResult =
        response.results.find(
          result => result.providerInstanceId === this.remoteProviderId
        ) || response.results[0];

      if (!remoteResult) {
        return {
          commandId: command.id,
          providerInstanceId: this.descriptor.id,
          accepted: false,
          latencyMs: Date.now() - startedAt,
          errorCode: 'peer_result_missing',
          recoverable: true
        };
      }

      if (remoteResult.observedState) {
        this.state = {
          health: remoteResult.accepted ? 'online' : this.state.health,
          updatedAt: new Date().toISOString(),
          observed: {
            ...this.state.observed,
            ...remoteResult.observedState
          }
        };
      }

      return {
        ...remoteResult,
        commandId: command.id,
        providerInstanceId: this.descriptor.id,
        latencyMs: Math.max(remoteResult.latencyMs, Date.now() - startedAt)
      };
    } catch (error) {
      this.markPeerOffline();
      return {
        commandId: command.id,
        providerInstanceId: this.descriptor.id,
        accepted: false,
        latencyMs: Date.now() - startedAt,
        errorCode: error instanceof Error ? error.message : 'peer_node_unreachable',
        recoverable: true
      };
    }
  }

  async fetchAsset(request: ProviderAssetRequest): Promise<ProviderAsset> {
    const query = new URLSearchParams({ targetId: request.targetId });
    const assetKind = request.kind === 'clip.thumbnail'
      ? 'clip-thumbnail'
      : 'output-snapshot';

    if (request.kind === 'output.snapshot') {
      query.set('format', request.format || 'jpeg');
    }

    const response = await withTimeout(
      this.fetchImpl,
      `${this.peer.baseUrl}/provider-assets/${encodeURIComponent(this.remoteProviderId)}/${assetKind}?${query}`,
      {
        headers: {
          Authorization: `Bearer ${this.peer.token}`
        }
      },
      6000
    );

    if (!response.ok) {
      throw new Error('peer_provider_asset_failed');
    }

    return {
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      body: new Uint8Array(await response.arrayBuffer()),
      cacheControl: response.headers.get('cache-control') || 'no-store'
    };
  }

  private replaceCapabilities(capabilities: Capability[]): void {
    this.capabilitiesSet.clear();
    for (const capability of capabilities) this.capabilitiesSet.add(capability);
  }
}

export function makeFederatedProviderId(
  peerNodeId: string,
  remoteProviderId: string
): string {
  return federatedProviderId(peerNodeId, remoteProviderId);
}
