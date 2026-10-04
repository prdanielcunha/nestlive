import type {
  AudioBus,
  AudioCapability,
  AudioChannel,
  AudioCommandResult,
  AudioConsoleProvider,
  AudioConsoleState,
  AudioGroup,
  AudioSubscriptionScope,
  MeterFrame,
  MeterValue
} from '@millionsnest/nestlive-domain';
import { decodeX32MeterBlob, type OscArgument } from './osc';
import {
  dbToX32Level,
  linearMeterToDb,
  x32LevelToDb
} from './level';
import {
  UdpX32Transport,
  type X32Transport
} from './transport';

const X32_CAPABILITIES: ReadonlySet<AudioCapability> = new Set([
  'audio.console.state.read',
  'audio.channel.read',
  'audio.bus.read',
  'audio.group.read',
  'audio.meter.read',
  'audio.fader.write',
  'audio.mute.write',
  'audio.pan.write'
]);

function channelPath(index: number): string {
  return `/ch/${String(index).padStart(2, '0')}`;
}

function busPath(index: number): string {
  return `/bus/${String(index).padStart(2, '0')}`;
}

function dcaPath(index: number): string {
  return `/dca/${index}`;
}

function firstNumber(
  message: Awaited<ReturnType<X32Transport['request']>>
): number | undefined {
  const arg = message.args[0];
  return arg && (arg.type === 'f' || arg.type === 'i')
    ? arg.value
    : undefined;
}

function firstString(
  message: Awaited<ReturnType<X32Transport['request']>>
): string | undefined {
  const arg = message.args[0];
  return arg?.type === 's' ? arg.value : undefined;
}

function commandResult(
  providerInstanceId: string,
  targetId: string,
  observedState: Record<string, unknown>,
  startedAt: number
): AudioCommandResult {
  return {
    accepted: true,
    providerInstanceId,
    targetId,
    observedState,
    latencyMs: Math.max(0, Date.now() - startedAt)
  };
}

export interface X32ProviderOptions {
  providerInstanceId: string;
  targetAddress: string;
  localAddress?: string;
  transport?: X32Transport;
}

export class X32AudioConsoleProvider implements AudioConsoleProvider {
  readonly providerInstanceId: string;
  private readonly transport: X32Transport;
  private meterSequence = 0;

  constructor(options: X32ProviderOptions) {
    this.providerInstanceId = options.providerInstanceId;
    this.transport =
      options.transport ??
      new UdpX32Transport({
        targetAddress: options.targetAddress,
        localAddress: options.localAddress
      });
  }

  capabilities(): ReadonlySet<AudioCapability> {
    return X32_CAPABILITIES;
  }

  async probe(): Promise<{
    reachable: boolean;
    model?: string;
    firmware?: string;
  }> {
    try {
      const message = await this.transport.request('/xinfo', [], 700);
      const strings = message.args
        .filter(arg => arg.type === 's')
        .map(arg => (arg as { type: 's'; value: string }).value);

      return {
        reachable: true,
        model: strings[2],
        firmware: strings[3]
      };
    } catch {
      return { reachable: false };
    }
  }

  async getConsoleState(): Promise<AudioConsoleState> {
    const probe = await this.probe();
    return {
      providerInstanceId: this.providerInstanceId,
      model: probe.model ?? 'Behringer X32',
      firmware: probe.firmware,
      connected: probe.reachable,
      updatedAt: Date.now(),
      observed: {
        protocol: 'OSC/UDP',
        port: 10023
      }
    };
  }

  async getChannels(): Promise<AudioChannel[]> {
    const channels: AudioChannel[] = [];

    for (let index = 1; index <= 32; index += 1) {
      const path = channelPath(index);
      const [nameReply, faderReply, onReply, panReply] =
        await Promise.all([
          this.transport.request(`${path}/config/name`),
          this.transport.request(`${path}/mix/fader`),
          this.transport.request(`${path}/mix/on`),
          this.transport.request(`${path}/mix/pan`)
        ]);

      const rawFader = firstNumber(faderReply) ?? 0;
      const rawOn = firstNumber(onReply) ?? 0;
      const rawPan = firstNumber(panReply) ?? 0.5;

      channels.push({
        id: `ch-${String(index).padStart(2, '0')}`,
        name: firstString(nameReply)?.trim() || `CH ${index}`,
        index,
        faderDb: x32LevelToDb(rawFader),
        mute: rawOn < 0.5,
        pan: rawPan * 2 - 1
      });
    }

    return channels;
  }

  async getBuses(): Promise<AudioBus[]> {
    const buses: AudioBus[] = [];

    for (let index = 1; index <= 16; index += 1) {
      const path = busPath(index);
      const [nameReply, faderReply, onReply] = await Promise.all([
        this.transport.request(`${path}/config/name`),
        this.transport.request(`${path}/mix/fader`),
        this.transport.request(`${path}/mix/on`)
      ]);

      buses.push({
        id: `bus-${String(index).padStart(2, '0')}`,
        name: firstString(nameReply)?.trim() || `Bus ${index}`,
        index,
        faderDb: x32LevelToDb(firstNumber(faderReply) ?? 0),
        mute: (firstNumber(onReply) ?? 0) < 0.5
      });
    }

    return buses;
  }

  async getGroups(): Promise<AudioGroup[]> {
    const groups: AudioGroup[] = [];

    for (let index = 1; index <= 8; index += 1) {
      const path = dcaPath(index);
      const [nameReply, faderReply, onReply] = await Promise.all([
        this.transport.request(`${path}/config/name`),
        this.transport.request(`${path}/fader`),
        this.transport.request(`${path}/on`)
      ]);

      groups.push({
        id: `dca-${index}`,
        name: firstString(nameReply)?.trim() || `DCA ${index}`,
        index,
        faderDb: x32LevelToDb(firstNumber(faderReply) ?? 0),
        mute: (firstNumber(onReply) ?? 0) < 0.5
      });
    }

    return groups;
  }

  async setFader(
    channelId: string,
    valueDb: number
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const address = `${channelPath(index)}/mix/fader`;
    const value = dbToX32Level(valueDb);

    await this.transport.send(address, [{ type: 'f', value }]);
    const reply = await this.transport.request(address);
    const observed = x32LevelToDb(firstNumber(reply) ?? value);

    return commandResult(
      this.providerInstanceId,
      channelId,
      { faderDb: observed },
      startedAt
    );
  }

  async setMute(
    channelId: string,
    value: boolean
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const address = `${channelPath(index)}/mix/on`;

    await this.transport.send(address, [
      { type: 'i', value: value ? 0 : 1 }
    ]);
    const reply = await this.transport.request(address);
    const observedOn = firstNumber(reply) ?? (value ? 0 : 1);

    return commandResult(
      this.providerInstanceId,
      channelId,
      { mute: observedOn < 0.5 },
      startedAt
    );
  }

  async setPan(
    channelId: string,
    value: number
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const address = `${channelPath(index)}/mix/pan`;
    const normalized = (Math.max(-1, Math.min(1, value)) + 1) / 2;

    await this.transport.send(address, [
      { type: 'f', value: normalized }
    ]);
    const reply = await this.transport.request(address);
    const observed = (firstNumber(reply) ?? normalized) * 2 - 1;

    return commandResult(
      this.providerInstanceId,
      channelId,
      { pan: observed },
      startedAt
    );
  }

  async *subscribeMeters(
    scope: AudioSubscriptionScope = {}
  ): AsyncIterable<MeterFrame> {
    const timeFactor = Math.max(
      1,
      Math.min(99, Math.round((scope.intervalMs ?? 50) / 50))
    );

    const subscribe = async () => {
      const args: OscArgument[] = [
        { type: 's', value: '/meters/1' },
        { type: 'i', value: timeFactor }
      ];
      await this.transport.send('/meters', args);
      await this.transport.send('/meters', [
        { type: 's', value: '/meters/2' },
        { type: 'i', value: timeFactor }
      ]);
    };

    await subscribe();
    const renew = setInterval(() => {
      void subscribe();
    }, 8000);

    try {
      for await (const message of this.transport.messages(scope.signal)) {
        if (
          message.address !== '/meters/1' &&
          message.address !== '/meters/2'
        ) {
          continue;
        }

        const blob = message.args.find(
          arg => arg.type === 'b'
        ) as { type: 'b'; value: Uint8Array } | undefined;
        if (!blob) continue;

        const values = decodeX32MeterBlob(blob.value);
        const capturedAt = Date.now();

        if (message.address === '/meters/1') {
          const channels: MeterValue[] = values
            .slice(0, 32)
            .map((value, index) => {
              const db = linearMeterToDb(value ?? 0);
              const dyn = values[64 + index];
              return {
                id: `ch-${String(index + 1).padStart(2, '0')}`,
                preFaderDb: db,
                peakDb: db,
                gainReductionDb:
                  dyn === undefined ? undefined : Math.min(0, linearMeterToDb(dyn)),
                clip: (value ?? 0) >= 1
              };
            });

          yield {
            providerInstanceId: this.providerInstanceId,
            sequence: ++this.meterSequence,
            capturedAt,
            channels:
              scope.channelIds?.length
                ? channels.filter(channel =>
                    scope.channelIds?.includes(channel.id)
                  )
                : channels
          };
          continue;
        }

        const buses: MeterValue[] = values
          .slice(0, 16)
          .map((value, index) => ({
            id: `bus-${String(index + 1).padStart(2, '0')}`,
            peakDb: linearMeterToDb(value ?? 0),
            clip: (value ?? 0) >= 1
          }));

        const mainLeft = values[22] ?? 0;
        const mainRight = values[23] ?? 0;
        yield {
          providerInstanceId: this.providerInstanceId,
          sequence: ++this.meterSequence,
          capturedAt,
          channels: [],
          buses,
          mains: [
            {
              id: 'main-l',
              peakDb: linearMeterToDb(mainLeft),
              clip: mainLeft >= 1
            },
            {
              id: 'main-r',
              peakDb: linearMeterToDb(mainRight),
              clip: mainRight >= 1
            }
          ]
        };
      }
    } finally {
      clearInterval(renew);
    }
  }

  async dispose(): Promise<void> {
    await this.transport.close();
  }

  private parseChannelId(channelId: string): number {
    const match = /^ch-(\d{2})$/.exec(channelId);
    const index = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(index) || index < 1 || index > 32) {
      throw new Error(`invalid_x32_channel_id:${channelId}`);
    }
    return index;
  }
}
