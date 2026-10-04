import type {
  AdapterManifest,
  Capability,
  CommandResult,
  LiveCommand,
  ProductionAdapterKey,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderState
} from '@millionsnest/nestlive-production-domain';
import type {
  ControlInvocation,
  ProductionControlClient
} from './clients';

export interface ProductionControlAdapterOptions {
  id: string;
  nodeId: string;
  displayName?: string;
  manifest: AdapterManifest;
  client: ProductionControlClient;
}

function text(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function translateAction(
  adapterKey: ProductionAdapterKey,
  command: LiveCommand
): { action: string; payload: Record<string, unknown> } {
  const payload = { ...(command.payload || {}) };

  if (command.capability === 'automation.trigger') {
    const action = text(payload, 'action', 'requestType', 'function', 'name', 'id');
    if (!action) throw new Error('production_action_required');
    delete payload.action;
    delete payload.requestType;
    delete payload.function;
    return { action, payload };
  }

  if (command.capability === 'audio.route.write') {
    if (adapterKey === 'osc') {
      const address = text(payload, 'address');
      if (!address) throw new Error('osc_address_required');
      return { action: address, payload };
    }
    if (adapterKey === 'midi') {
      return { action: text(payload, 'action') || 'midi.send', payload };
    }
    throw new Error('capability_not_supported');
  }

  if (command.capability === 'presentation.preview') {
    const target = text(payload, 'sceneName', 'input', 'target', 'id');
    if (!target) throw new Error('preview_target_required');
    if (adapterKey === 'obs-websocket') {
      return {
        action: 'SetCurrentPreviewScene',
        payload: { sceneName: target }
      };
    }
    if (adapterKey === 'vmix') {
      return {
        action: 'PreviewInput',
        payload: { Input: target }
      };
    }
    if (adapterKey === 'atem') {
      return { action: 'previewInput', payload: { input: target } };
    }
    throw new Error('capability_not_supported');
  }

  if (command.capability === 'presentation.take') {
    const target = text(payload, 'sceneName', 'input', 'target', 'id');
    if (adapterKey === 'obs-websocket') {
      if (!target) throw new Error('take_target_required');
      return {
        action: 'SetCurrentProgramScene',
        payload: { sceneName: target }
      };
    }
    if (adapterKey === 'vmix') {
      const transition = text(payload, 'transition') || 'Cut';
      const translated: Record<string, unknown> = { ...payload };
      if (target) translated.Input = target;
      if (payload.durationMs !== undefined) translated.Duration = payload.durationMs;
      delete translated.transition;
      delete translated.durationMs;
      delete translated.input;
      delete translated.sceneName;
      delete translated.target;
      delete translated.id;
      return { action: transition, payload: translated };
    }
    if (adapterKey === 'atem') {
      return {
        action: text(payload, 'transition') === 'auto'
          ? 'autoTransition'
          : 'cutTransition',
        payload: target ? { input: target } : {}
      };
    }
    throw new Error('capability_not_supported');
  }

  if (command.capability === 'presentation.clear') {
    if (adapterKey === 'obs-websocket') {
      const blankScene = text(payload, 'blankScene', 'sceneName');
      if (!blankScene) throw new Error('obs_blank_scene_required');
      return {
        action: 'SetCurrentProgramScene',
        payload: { sceneName: blankScene }
      };
    }
    if (adapterKey === 'vmix') {
      return { action: 'FadeToBlack', payload: {} };
    }
    if (adapterKey === 'atem') {
      return { action: 'fadeToBlack', payload: {} };
    }
    throw new Error('capability_not_supported');
  }

  throw new Error('capability_not_supported');
}

export class ProductionControlAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly observationIntervalMs = 1000;
  private readonly supported: ReadonlySet<Capability>;
  private state: ProviderState = {
    health: 'offline',
    updatedAt: new Date(0).toISOString(),
    observed: {}
  };

  constructor(private readonly options: ProductionControlAdapterOptions) {
    this.supported = new Set(options.manifest.capabilities);
    this.descriptor = {
      id: options.id,
      nodeId: options.nodeId,
      kind: options.manifest.providerKind,
      displayName: options.displayName || options.manifest.displayName,
      providerKey: options.manifest.adapterKey
    };
  }

  capabilities(): ReadonlySet<Capability> {
    return this.supported;
  }

  peekState(): ProviderState {
    return structuredClone(this.state);
  }

  async probe() {
    const result = await this.options.client.probe();
    this.descriptor.version = result.version;
    this.state = {
      health: result.reachable ? 'online' : 'offline',
      updatedAt: new Date().toISOString(),
      observed: result.observed || (
        result.reason ? { error: result.reason } : {}
      )
    };
    return {
      reachable: result.reachable,
      version: result.version,
      capabilities: result.reachable ? [...this.supported] : [],
      reason: result.reason
    };
  }

  async getState(): Promise<ProviderState> {
    if (!this.options.client.getState) {
      await this.probe();
      return this.peekState();
    }

    try {
      const observed = await this.options.client.getState();
      this.state = {
        health: 'online',
        updatedAt: new Date().toISOString(),
        observed
      };
    } catch (error) {
      this.state = {
        health: 'degraded',
        updatedAt: new Date().toISOString(),
        observed: {
          ...this.state.observed,
          error: error instanceof Error ? error.message : 'production_state_failed'
        }
      };
    }
    return this.peekState();
  }

  async execute(command: LiveCommand): Promise<CommandResult> {
    const started = performance.now();
    if (!this.supported.has(command.capability)) {
      return this.result(command, started, {
        accepted: false,
        errorCode: 'capability_not_supported',
        recoverable: false
      });
    }

    try {
      const translated = translateAction(
        this.options.manifest.adapterKey,
        command
      );
      const invocation = await this.options.client.invoke(
        translated.action,
        translated.payload
      );
      if (invocation.observed) {
        this.state = {
          health: invocation.accepted ? 'online' : this.state.health,
          updatedAt: new Date().toISOString(),
          observed: {
            ...this.state.observed,
            ...invocation.observed
          }
        };
      }
      return this.result(command, started, invocation);
    } catch (error) {
      return this.result(command, started, {
        accepted: false,
        errorCode: error instanceof Error ? error.message : 'production_command_failed',
        recoverable: false
      });
    }
  }

  async dispose(): Promise<void> {
    await this.options.client.dispose?.();
  }

  private result(
    command: LiveCommand,
    started: number,
    invocation: ControlInvocation
  ): CommandResult {
    return {
      commandId: command.id,
      providerInstanceId: this.descriptor.id,
      accepted: invocation.accepted,
      observedState: invocation.observed,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      errorCode: invocation.errorCode,
      recoverable: invocation.recoverable
    };
  }
}
