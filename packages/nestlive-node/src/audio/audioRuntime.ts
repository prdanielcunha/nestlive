import {
  AUDIO_SAFETY_BY_CAPABILITY,
  capabilityForAudioCommand,
  type AudioCommandEnvelope,
  type AudioCommandExecution,
  type AudioConsoleProvider,
  type AudioSafetyLevel,
  type AudioStatePatch,
  type MeterFrame
} from '@millionsnest/nestlive-domain';
import { LatestMeterFrameBuffer } from './meterPriority';

function safetyRank(level: AudioSafetyLevel): number {
  return level === 'normal' ? 0 : level === 'guarded' ? 1 : 2;
}

type StateListener = (patch: AudioStatePatch) => void;

export class NestLiveAudioRuntime {
  private readonly providers = new Map<string, AudioConsoleProvider>();
  private readonly meterBuffers = new Map<string, LatestMeterFrameBuffer>();
  private readonly latestMeters = new Map<string, MeterFrame>();
  private readonly meterAbort = new Map<string, AbortController>();
  private readonly stateAbort = new Map<string, AbortController>();
  private readonly stateListeners = new Map<string, Set<StateListener>>();
  private readonly latestState = new Map<string, AudioStatePatch>();

  register(provider: AudioConsoleProvider): void {
    if (this.providers.has(provider.providerInstanceId)) {
      throw new Error('audio_provider_already_registered');
    }
    this.providers.set(provider.providerInstanceId, provider);
    this.meterBuffers.set(
      provider.providerInstanceId,
      new LatestMeterFrameBuffer()
    );
    this.stateListeners.set(provider.providerInstanceId, new Set());
  }

  hasProvider(providerInstanceId: string): boolean {
    return this.providers.has(providerInstanceId);
  }

  async removeProvider(providerInstanceId: string): Promise<boolean> {
    const provider = this.providers.get(providerInstanceId);
    if (!provider) return false;
    this.stopMeters(providerInstanceId);
    this.stopState(providerInstanceId);
    await provider.dispose?.();
    this.providers.delete(providerInstanceId);
    this.meterBuffers.delete(providerInstanceId);
    this.latestMeters.delete(providerInstanceId);
    this.latestState.delete(providerInstanceId);
    this.stateListeners.delete(providerInstanceId);
    return true;
  }

  getProvider(providerInstanceId: string): AudioConsoleProvider {
    const provider = this.providers.get(providerInstanceId);
    if (!provider) throw new Error('audio_provider_not_found');
    return provider;
  }

  listProviders(): Array<{
    providerInstanceId: string;
    capabilities: string[];
  }> {
    return [...this.providers.values()].map(provider => ({
      providerInstanceId: provider.providerInstanceId,
      capabilities: [...provider.capabilities()]
    }));
  }

  async startTelemetry(
    providerInstanceId: string,
    intervalMs = 40
  ): Promise<void> {
    const provider = this.getProvider(providerInstanceId);

    if (provider.subscribeMeters) {
      await this.startMeters(providerInstanceId, intervalMs);
    }

    if (provider.subscribeState) {
      await this.startState(providerInstanceId, Math.max(50, intervalMs));
    }
  }

  async startMeters(
    providerInstanceId: string,
    intervalMs = 40
  ): Promise<void> {
    const provider = this.getProvider(providerInstanceId);
    const subscribeMeters = provider.subscribeMeters?.bind(provider);
    if (!subscribeMeters) {
      throw new Error('audio_meter_not_supported');
    }

    this.stopMeters(providerInstanceId);
    const abort = new AbortController();
    this.meterAbort.set(providerInstanceId, abort);
    const buffer = this.meterBuffers.get(providerInstanceId)!;

    void (async () => {
      try {
        for await (const frame of subscribeMeters({
          intervalMs,
          signal: abort.signal
        })) {
          buffer.push(frame);
          this.latestMeters.set(providerInstanceId, frame);
          if (abort.signal.aborted) break;
        }
      } catch {
        if (!abort.signal.aborted) {
          // Provider health and stale meters expose failure without crashing Node.
        }
      }
    })();
  }

  async startState(
    providerInstanceId: string,
    intervalMs = 100
  ): Promise<void> {
    const provider = this.getProvider(providerInstanceId);
    const subscribeState = provider.subscribeState?.bind(provider);
    if (!subscribeState) {
      throw new Error('audio_state_subscription_not_supported');
    }

    this.stopState(providerInstanceId);
    const abort = new AbortController();
    this.stateAbort.set(providerInstanceId, abort);

    void (async () => {
      try {
        for await (const patch of subscribeState({
          intervalMs,
          signal: abort.signal
        })) {
          this.latestState.set(providerInstanceId, patch);
          const listeners = this.stateListeners.get(providerInstanceId);
          if (listeners) {
            for (const listener of listeners) {
              try {
                listener(patch);
              } catch {
                // One UI subscriber never interrupts provider reconciliation.
              }
            }
          }
          if (abort.signal.aborted) break;
        }
      } catch {
        if (!abort.signal.aborted) {
          // Reconciliation failures remain isolated from command execution.
        }
      }
    })();
  }

  stopMeters(providerInstanceId: string): void {
    this.meterAbort.get(providerInstanceId)?.abort();
    this.meterAbort.delete(providerInstanceId);
  }

  stopState(providerInstanceId: string): void {
    this.stateAbort.get(providerInstanceId)?.abort();
    this.stateAbort.delete(providerInstanceId);
  }

  takeLatestMeter(providerInstanceId: string) {
    return this.meterBuffers.get(providerInstanceId)?.takeLatest();
  }

  latestMeter(providerInstanceId: string) {
    return this.latestMeters.get(providerInstanceId);
  }

  latestStatePatch(providerInstanceId: string) {
    return this.latestState.get(providerInstanceId);
  }

  subscribeStateEvents(
    providerInstanceId: string,
    listener: StateListener
  ): () => void {
    this.getProvider(providerInstanceId);
    const listeners =
      this.stateListeners.get(providerInstanceId) ?? new Set<StateListener>();
    listeners.add(listener);
    this.stateListeners.set(providerInstanceId, listeners);

    return () => {
      listeners.delete(listener);
    };
  }

  async execute(
    envelope: AudioCommandEnvelope
  ): Promise<AudioCommandExecution> {
    const provider = this.getProvider(envelope.providerInstanceId);
    const capability = capabilityForAudioCommand(envelope.command);

    if (!provider.capabilities().has(capability)) {
      throw new Error(`audio_capability_unavailable:${capability}`);
    }

    const safetyLevel =
      AUDIO_SAFETY_BY_CAPABILITY[capability] ?? 'normal';

    if (
      safetyRank(safetyLevel) > 0 &&
      safetyRank(envelope.confirmedSafetyLevel ?? 'normal') <
        safetyRank(safetyLevel)
    ) {
      throw new Error(`audio_confirmation_required:${safetyLevel}`);
    }

    const command = envelope.command;
    let result;

    switch (command.type) {
      case 'setFader':
        if (!provider.setFader) throw new Error('audio_method_unavailable');
        result = await provider.setFader(command.channelId, command.valueDb);
        break;
      case 'setMute':
        if (!provider.setMute) throw new Error('audio_method_unavailable');
        result = await provider.setMute(command.channelId, command.value);
        break;
      case 'setPan':
        if (!provider.setPan) throw new Error('audio_method_unavailable');
        result = await provider.setPan(command.channelId, command.value);
        break;
      case 'setGain':
        if (!provider.setGain) throw new Error('audio_method_unavailable');
        result = await provider.setGain(command.channelId, command.valueDb);
        break;
      case 'setPhantom':
        if (!provider.setPhantom) throw new Error('audio_method_unavailable');
        result = await provider.setPhantom(command.channelId, command.value);
        break;
      case 'setEq':
        if (!provider.setEq) throw new Error('audio_method_unavailable');
        result = await provider.setEq(command.channelId, command.eq);
        break;
      case 'setGate':
        if (!provider.setGate) throw new Error('audio_method_unavailable');
        result = await provider.setGate(command.channelId, command.gate);
        break;
      case 'setCompressor':
        if (!provider.setCompressor) throw new Error('audio_method_unavailable');
        result = await provider.setCompressor(
          command.channelId,
          command.compressor
        );
        break;
      case 'setBusSend':
        if (!provider.setBusSend) throw new Error('audio_method_unavailable');
        result = await provider.setBusSend(
          command.channelId,
          command.busId,
          command.valueDb
        );
        break;
      case 'loadScene':
        if (!provider.loadScene) throw new Error('audio_method_unavailable');
        result = await provider.loadScene(command.sceneId);
        break;
    }

    if (!result.accepted) {
      throw new Error(result.errorCode ?? 'audio_command_rejected');
    }

    return {
      envelope,
      capability,
      safetyLevel,
      result
    };
  }

  async dispose(): Promise<void> {
    for (const providerId of [...this.meterAbort.keys()]) {
      this.stopMeters(providerId);
    }
    for (const providerId of [...this.stateAbort.keys()]) {
      this.stopState(providerId);
    }
    await Promise.all(
      [...this.providers.values()].map(provider =>
        provider.dispose?.()
      )
    );
    this.providers.clear();
    this.meterBuffers.clear();
    this.latestMeters.clear();
    this.latestState.clear();
    this.stateListeners.clear();
  }
}
