import type {
  AudioBus,
  AudioCapability,
  AudioChannel,
  AudioCommandResult,
  AudioConsoleProvider,
  AudioConsoleState,
  AudioGroup,
  AudioStatePatch,
  AudioSubscriptionScope,
  MeterFrame,
  MeterValue
} from '@millionsnest/nestlive-domain';

const CAPABILITIES: ReadonlySet<AudioCapability> = new Set([
  'audio.console.state.read',
  'audio.channel.read',
  'audio.bus.read',
  'audio.group.read',
  'audio.meter.read',
  'audio.fader.write',
  'audio.mute.write',
  'audio.pan.write',
  'audio.gain.write'
]);

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SimulatedAudioConsoleProvider implements AudioConsoleProvider {
  readonly providerInstanceId: string;
  private sequence = 0;
  private tick = 0;

  private channels: AudioChannel[] = [
    { id: 'ch-01', name: 'Pastor', index: 1, faderDb: -3, mute: false, pan: 0, gainDb: 24 },
    { id: 'ch-02', name: 'Vocal 1', index: 2, faderDb: -5, mute: false, pan: -0.1, gainDb: 22 },
    { id: 'ch-03', name: 'Guitarra', index: 3, faderDb: -7, mute: false, pan: 0.2, gainDb: 18 }
  ];

  private buses: AudioBus[] = [
    { id: 'bus-01', name: 'Monitor 1', index: 1, faderDb: -2, mute: false }
  ];

  private groups: AudioGroup[] = [
    {
      id: 'dca-voice',
      name: 'DCA Voz',
      index: 1,
      faderDb: 0,
      mute: false,
      memberIds: ['ch-01', 'ch-02']
    }
  ];

  constructor(providerInstanceId = 'sim-console-1') {
    this.providerInstanceId = providerInstanceId;
  }

  capabilities(): ReadonlySet<AudioCapability> {
    return CAPABILITIES;
  }

  async getConsoleState(): Promise<AudioConsoleState> {
    return {
      providerInstanceId: this.providerInstanceId,
      model: 'NestLive Simulator',
      firmware: 'sim-0.1',
      connected: true,
      updatedAt: Date.now(),
      observed: { transport: 'memory' }
    };
  }

  async getChannels(): Promise<AudioChannel[]> {
    return this.channels.map(channel => ({ ...channel }));
  }

  async getBuses(): Promise<AudioBus[]> {
    return this.buses.map(bus => ({ ...bus }));
  }

  async getGroups(): Promise<AudioGroup[]> {
    return this.groups.map(group => ({
      ...group,
      memberIds: [...(group.memberIds ?? [])]
    }));
  }

  private result(
    targetId: string,
    observedState: Record<string, unknown>
  ): AudioCommandResult {
    return {
      accepted: true,
      providerInstanceId: this.providerInstanceId,
      targetId,
      observedState,
      latencyMs: 1
    };
  }

  private channel(channelId: string): AudioChannel {
    const channel = this.channels.find(item => item.id === channelId);
    if (!channel) throw new Error(`channel_not_found:${channelId}`);
    return channel;
  }

  async setFader(channelId: string, valueDb: number): Promise<AudioCommandResult> {
    const channel = this.channel(channelId);
    channel.faderDb = valueDb;
    return this.result(channelId, { faderDb: valueDb });
  }

  async setMute(channelId: string, value: boolean): Promise<AudioCommandResult> {
    const channel = this.channel(channelId);
    channel.mute = value;
    return this.result(channelId, { mute: value });
  }

  async setPan(channelId: string, value: number): Promise<AudioCommandResult> {
    const channel = this.channel(channelId);
    channel.pan = Math.max(-1, Math.min(1, value));
    return this.result(channelId, { pan: channel.pan });
  }

  async setGain(channelId: string, valueDb: number): Promise<AudioCommandResult> {
    const channel = this.channel(channelId);
    channel.gainDb = valueDb;
    return this.result(channelId, { gainDb: valueDb });
  }

  nextMeterFrame(now = Date.now()): MeterFrame {
    this.tick += 1;
    this.sequence += 1;

    const values = this.channels.map((channel, index): MeterValue => {
      const muted = channel.mute === true;
      const base = -18 - index * 3;
      const movement = Math.sin((this.tick + index * 4) / 5) * 8;
      const peakDb = muted ? -96 : Math.min(1.5, base + movement);

      return {
        id: channel.id,
        preFaderDb: muted ? -96 : peakDb - 1.5,
        postFaderDb: muted
          ? -96
          : peakDb + Math.min(0, channel.faderDb ?? 0),
        peakDb,
        rmsDb: muted ? -96 : peakDb - 6,
        gainReductionDb: index === 0 ? -2.2 : 0,
        gateOpen: !muted && peakDb > -45,
        clip: peakDb >= 0
      };
    });

    return {
      providerInstanceId: this.providerInstanceId,
      sequence: this.sequence,
      capturedAt: now,
      channels: values,
      buses: [{ id: 'bus-01', peakDb: -10 + Math.sin(this.tick / 7) * 4 }],
      mains: [{ id: 'main-lr', peakDb: -7 + Math.sin(this.tick / 6) * 3 }]
    };
  }

  async *subscribeMeters(
    scope: AudioSubscriptionScope = {}
  ): AsyncIterable<MeterFrame> {
    const intervalMs = Math.max(20, scope.intervalMs ?? 40);

    while (!scope.signal?.aborted) {
      const frame = this.nextMeterFrame();
      if (scope.channelIds?.length) {
        frame.channels = frame.channels.filter(value =>
          scope.channelIds?.includes(value.id)
        );
      }
      yield frame;
      await delay(intervalMs);
    }
  }

  async *subscribeState(
    scope: AudioSubscriptionScope = {}
  ): AsyncIterable<AudioStatePatch> {
    let last = JSON.stringify(this.channels);

    while (!scope.signal?.aborted) {
      const current = JSON.stringify(this.channels);
      if (current !== last) {
        last = current;
        yield {
          providerInstanceId: this.providerInstanceId,
          sequence: ++this.sequence,
          capturedAt: Date.now(),
          scope: 'console',
          patch: { channels: await this.getChannels() }
        };
      }
      await delay(Math.max(50, scope.intervalMs ?? 100));
    }
  }
}
