import {
  AUDIO_SAFETY_BY_CAPABILITY,
  capabilityForAudioCommand,
  type AudioCommandEnvelope,
  type AudioCommandExecution,
  type AudioConsoleProvider,
  type AudioSafetyLevel
} from '@millionsnest/nestlive-domain';
import { LatestMeterFrameBuffer } from './meterPriority';

function safetyRank(level: AudioSafetyLevel): number {
  return level === 'normal' ? 0 : level === 'guarded' ? 1 : 2;
}

export class NestLiveAudioRuntime {
  private readonly providers = new Map<string, AudioConsoleProvider>();
  private readonly meterBuffers = new Map<string, LatestMeterFrameBuffer>();
  private readonly meterAbort = new Map<string, AbortController>();

  register(provider: AudioConsoleProvider): void {
    if (this.providers.has(provider.providerInstanceId)) {
      throw new Error('audio_provider_already_registered');
    }
    this.providers.set(provider.providerInstanceId, provider);
    this.meterBuffers.set(
      provider.providerInstanceId,
      new LatestMeterFrameBuffer()
    );
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

  async startMeters(
    providerInstanceId: string,
    intervalMs = 40
  ): Promise<void> {
    const provider = this.getProvider(providerInstanceId);
    if (!provider.subscribeMeters) {
      throw new Error('audio_meter_not_supported');
    }

    this.stopMeters(providerInstanceId);
    const abort = new AbortController();
    this.meterAbort.set(providerInstanceId, abort);
    const buffer = this.meterBuffers.get(providerInstanceId)!;

    void (async () => {
      try {
        for await (const frame of provider.subscribeMeters({
          intervalMs,
          signal: abort.signal
        })) {
          buffer.push(frame);
          if (abort.signal.aborted) break;
        }
      } catch {
        if (!abort.signal.aborted) {
          // Health surfaces read provider state; telemetry failure must not crash Node.
        }
      }
    })();
  }

  stopMeters(providerInstanceId: string): void {
    this.meterAbort.get(providerInstanceId)?.abort();
    this.meterAbort.delete(providerInstanceId);
  }

  takeLatestMeter(providerInstanceId: string) {
    return this.meterBuffers.get(providerInstanceId)?.takeLatest();
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
    for (const providerId of this.meterAbort.keys()) {
      this.stopMeters(providerId);
    }
    await Promise.all(
      [...this.providers.values()].map(provider =>
        provider.dispose?.()
      )
    );
    this.providers.clear();
  }
}
