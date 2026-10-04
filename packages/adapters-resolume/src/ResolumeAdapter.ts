import type {
  Capability,
  CommandResult,
  LiveCommand,
  ProviderAdapter,
  ProviderAsset,
  ProviderAssetRequest,
  ProviderDescriptor,
  ProviderState
} from '@millionsnest/nestlive-production-domain';
import type { ResolumeRestApi } from './ResolumeRestClient';
import type {
  ResolumeRealtimeClient,
  ResolumeRealtimeEvent
} from './ResolumeRealtimeClient';

const RESOLUME_CAPABILITIES: Capability[] = [
  'visual.composition.read',
  'visual.clip.trigger',
  'visual.layer.clear',
  'visual.composition.clear',
  'visual.outputs.read',
  'visual.output.snapshot',
  'visual.clip.thumbnail'
];

interface ProductInfo {
  name?: string;
  version?: string;
  product?: string;
  [key: string]: unknown;
}

export interface ResolumeAdapterOptions {
  id: string;
  nodeId: string;
  api: ResolumeRestApi;
  realtime?: ResolumeRealtimeClient;
  displayName?: string;
}

export class ResolumeAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly observationIntervalMs = 300;
  private readonly api: ResolumeRestApi;
  private readonly realtime?: ResolumeRealtimeClient;
  private readonly supported = new Set<Capability>();
  private realtimeConnecting = false;
  private realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCompositionAt = 0;
  private lastRealtimeEventAt: string | null = null;
  private lastState: ProviderState = {
    health: 'offline',
    updatedAt: new Date(0).toISOString(),
    observed: {}
  };

  constructor(options: ResolumeAdapterOptions) {
    this.api = options.api;
    this.realtime = options.realtime;
    this.descriptor = {
      id: options.id,
      nodeId: options.nodeId,
      kind: 'visual',
      displayName: options.displayName || 'Resolume Arena',
      providerKey: 'resolume'
    };
  }

  async probe() {
    try {
      const product = await this.api.get<ProductInfo>('/product');
      this.supported.clear();
      for (const capability of RESOLUME_CAPABILITIES) this.supported.add(capability);

      const version = product?.version ? String(product.version) : undefined;
      this.descriptor.version = version;
      this.lastState = {
        health: 'online',
        updatedAt: new Date().toISOString(),
        observed: {
          product,
          realtime: {
            supported: Boolean(this.realtime),
            connected: this.realtime?.isConnected() || false
          }
        }
      };
      void this.ensureRealtime();

      return {
        reachable: true,
        version,
        capabilities: [...this.supported]
      };
    } catch (error) {
      this.realtime?.stop();
      this.supported.clear();
      this.lastState = {
        health: 'offline',
        updatedAt: new Date().toISOString(),
        observed: {
          error: error instanceof Error ? error.message : 'resolume_probe_failed'
        }
      };
      return {
        reachable: false,
        capabilities: [] as Capability[],
        reason: error instanceof Error ? error.message : 'resolume_probe_failed'
      };
    }
  }

  capabilities(): ReadonlySet<Capability> {
    return this.supported;
  }

  peekState(): ProviderState {
    return {
      health: this.lastState.health,
      updatedAt: this.lastState.updatedAt,
      observed: { ...this.lastState.observed }
    };
  }

  async getState(): Promise<ProviderState> {
    if (!this.supported.has('visual.composition.read')) return this.lastState;

    void this.ensureRealtime();
    const realtimeFresh =
      this.realtime?.isConnected() &&
      this.lastCompositionAt > 0 &&
      Date.now() - this.lastCompositionAt < 1800;

    if (realtimeFresh) return this.peekState();
    await this.refreshComposition(false);
    return this.peekState();
  }

  async dispose(): Promise<void> {
    if (this.realtimeRefreshTimer) {
      clearTimeout(this.realtimeRefreshTimer);
      this.realtimeRefreshTimer = null;
    }
    this.realtime?.stop();
  }

  private async refreshComposition(throwOnError = false): Promise<void> {
    try {
      const composition = await this.api.get<Record<string, unknown>>('/composition');
      const now = new Date().toISOString();
      this.lastCompositionAt = Date.now();
      this.lastState = {
        health: 'online',
        updatedAt: now,
        observed: {
          ...this.lastState.observed,
          composition,
          realtime: {
            supported: Boolean(this.realtime),
            connected: this.realtime?.isConnected() || false,
            lastEventAt: this.lastRealtimeEventAt
          }
        }
      };
    } catch (error) {
      this.lastState = {
        health: 'degraded',
        updatedAt: new Date().toISOString(),
        observed: {
          ...this.lastState.observed,
          error: error instanceof Error ? error.message : 'resolume_state_failed',
          realtime: {
            supported: Boolean(this.realtime),
            connected: this.realtime?.isConnected() || false,
            lastEventAt: this.lastRealtimeEventAt
          }
        }
      };
      if (throwOnError) throw error;
    }
  }

  private async ensureRealtime(): Promise<void> {
    if (!this.realtime || this.realtime.isConnected() || this.realtimeConnecting) return;
    this.realtimeConnecting = true;
    try {
      const connected = await this.realtime.start(event => this.handleRealtimeEvent(event));
      if (connected) this.scheduleRealtimeRefresh(0);
    } finally {
      this.realtimeConnecting = false;
    }
  }

  private handleRealtimeEvent(event: ResolumeRealtimeEvent): void {
    this.lastRealtimeEventAt = event.receivedAt;
    this.lastState = {
      ...this.lastState,
      health: this.lastState.health,
      updatedAt: event.receivedAt,
      observed: {
        ...this.lastState.observed,
        realtime: {
          supported: true,
          connected: event.type === 'open' || event.type === 'message'
            ? true
            : this.realtime?.isConnected() || false,
          lastEventAt: event.receivedAt,
          lastEventType: event.type
        }
      }
    };

    if (event.type === 'open' || event.type === 'message') {
      this.scheduleRealtimeRefresh(event.type === 'open' ? 0 : 55);
    }
  }

  private scheduleRealtimeRefresh(delayMs: number): void {
    if (this.realtimeRefreshTimer) return;
    this.realtimeRefreshTimer = setTimeout(() => {
      this.realtimeRefreshTimer = null;
      void this.refreshComposition(false);
    }, delayMs);
  }

  async fetchAsset(request: ProviderAssetRequest): Promise<ProviderAsset> {
    if (request.kind === 'output.snapshot') {
      if (!this.supported.has('visual.output.snapshot')) {
        throw new Error('capability_not_supported');
      }

      const targetId = String(request.targetId || '');
      if (!targetId) throw new Error('resolume_monitor_id_required');
      const extension = request.format === 'png' ? 'png' : 'jpg';
      const response = await this.api.getBinary(
        `/composition/monitors/${encodeURIComponent(targetId)}/snapshot.${extension}`
      );
      return {
        contentType: response.contentType,
        body: response.body,
        cacheControl: 'no-store'
      };
    }

    if (request.kind === 'clip.thumbnail') {
      if (!this.supported.has('visual.clip.thumbnail')) {
        throw new Error('capability_not_supported');
      }

      const targetId = String(request.targetId || '');
      if (!targetId) throw new Error('resolume_clip_id_required');
      const response = await this.api.getBinary(
        `/composition/clips/by-id/${encodeURIComponent(targetId)}/thumbnail`
      );
      return {
        contentType: response.contentType,
        body: response.body,
        cacheControl: 'private, max-age=120'
      };
    }

    throw new Error('capability_not_supported');
  }

  async execute(command: LiveCommand): Promise<CommandResult> {
    const started = performance.now();
    try {
      if (!this.supported.has(command.capability)) {
        return this.result(command, started, false, 'capability_not_supported', true);
      }

      const observedState = await this.executeCapability(command);
      return {
        commandId: command.id,
        providerInstanceId: this.descriptor.id,
        accepted: true,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        observedState
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'resolume_command_failed';
      const recoverable = message.includes('timeout') || message.includes('http_5');
      return this.result(
        command,
        started,
        false,
        recoverable ? 'provider_timeout' : 'provider_permission_denied',
        recoverable
      );
    }
  }

  private async executeCapability(
    command: LiveCommand
  ): Promise<Record<string, unknown> | undefined> {
    const payload = command.payload as Record<string, unknown>;

    switch (command.capability) {
      case 'visual.composition.read': {
        await this.refreshComposition(true);
        const composition = this.lastState.observed.composition;
        return composition && typeof composition === 'object'
          ? { composition }
          : undefined;
      }

      case 'visual.clip.trigger': {
        const clipId = String(payload.clipId || '');
        if (!clipId) throw new Error('resolume_clip_id_required');
        await this.api.post(`/composition/clips/by-id/${encodeURIComponent(clipId)}/connect`);
        this.scheduleRealtimeRefresh(35);
        return { activeClipId: clipId };
      }

      case 'visual.layer.clear': {
        const layerId = String(payload.layerId || '');
        if (!layerId) throw new Error('resolume_layer_id_required');
        await this.api.post(`/composition/layers/by-id/${encodeURIComponent(layerId)}/clear`);
        this.scheduleRealtimeRefresh(35);
        return { clearedLayerId: layerId };
      }

      case 'visual.composition.clear':
        await this.api.post('/composition/disconnect-all');
        this.scheduleRealtimeRefresh(35);
        return { compositionCleared: true };

      case 'visual.outputs.read': {
        const outputs = await this.api.get<unknown[]>('/composition/monitors');
        return { outputs: Array.isArray(outputs) ? outputs : [] };
      }

      case 'visual.output.snapshot':
        return { assetRequired: true };

      default:
        throw new Error('capability_not_supported');
    }
  }

  private result(
    command: LiveCommand,
    started: number,
    accepted: boolean,
    errorCode: string,
    recoverable: boolean
  ): CommandResult {
    return {
      commandId: command.id,
      providerInstanceId: this.descriptor.id,
      accepted,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      errorCode,
      recoverable
    };
  }
}
