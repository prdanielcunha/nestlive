import type {
  AudioBus,
  AudioCapability,
  AudioChannel,
  AudioChannelProcessingState,
  AudioCommandResult,
  AudioConsoleProvider,
  AudioConsoleState,
  AudioGroup,
  AudioRoutingState,
  AudioStatePatch,
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
  headampGainToNormalized,
  indexToRatio,
  linearToNormalized,
  logToNormalized,
  normalizedToHeadampGain,
  normalizedToLinear,
  normalizedToLog,
  normalizedToQ,
  qToNormalized,
  ratioToIndex,
  resolveX32HeadampIndex
} from './processing';
import {
  UdpX32Transport,
  type X32Transport
} from './transport';

const X32_BASE_CAPABILITIES: AudioCapability[] = [
  'audio.console.state.read',
  'audio.channel.read',
  'audio.bus.read',
  'audio.group.read',
  'audio.routing.read',
  'audio.meter.read',
  'audio.fader.write',
  'audio.mute.write',
  'audio.pan.write',
  'audio.busSend.write'
];

const X32_DEEP_CAPABILITIES: AudioCapability[] = [
  'audio.gain.write',
  'audio.phantom.write',
  'audio.eq.write',
  'audio.gate.write',
  'audio.compressor.write',
  'audio.scene.recall'
];

function channelPath(index: number): string {
  return `/ch/${String(index).padStart(2, '0')}`;
}

function busPath(index: number): string {
  return `/bus/${String(index).padStart(2, '0')}`;
}

function dcaPath(index: number): string {
  return `/dca/${index}`;
}

function headampPath(index: number): string {
  return `/headamp/${String(index).padStart(3, '0')}`;
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

function booleanValue(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`x32_${label}_must_be_boolean`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`x32_${label}_must_be_number`);
  }
  return value;
}

function integerValue(value: unknown, label: string): number | undefined {
  const number = numberValue(value, label);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number)) {
    throw new Error(`x32_${label}_must_be_integer`);
  }
  return number;
}

function parseSceneId(sceneId: string): number {
  const match = /^(?:scene-)?(\d{1,3})$/i.exec(sceneId.trim());
  const humanIndex = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(humanIndex) || humanIndex < 1 || humanIndex > 100) {
    throw new Error(`invalid_x32_scene_id:${sceneId}`);
  }
  return humanIndex - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface X32ProviderOptions {
  providerInstanceId: string;
  targetAddress: string;
  localAddress?: string;
  transport?: X32Transport;
  /**
   * Deep processing writes remain opt-in until a venue passes the physical
   * certification gate. The implementation exists in software, but no control
   * is advertised to the UI before this flag is enabled deliberately.
   */
  enableDeepControls?: boolean;
}

export class X32AudioConsoleProvider implements AudioConsoleProvider {
  readonly providerInstanceId: string;
  private readonly transport: X32Transport;
  private readonly capabilitySet: ReadonlySet<AudioCapability>;
  private readonly headampChannelIds = new Map<number, Set<string>>();
  private meterSequence = 0;

  constructor(options: X32ProviderOptions) {
    this.providerInstanceId = options.providerInstanceId;
    this.transport =
      options.transport ??
      new UdpX32Transport({
        targetAddress: options.targetAddress,
        localAddress: options.localAddress
      });

    this.capabilitySet = new Set([
      ...X32_BASE_CAPABILITIES,
      ...(options.enableDeepControls ? X32_DEEP_CAPABILITIES : [])
    ]);
  }

  capabilities(): ReadonlySet<AudioCapability> {
    return this.capabilitySet;
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
        port: 10023,
        deepControlsEnabled:
          this.capabilitySet.has('audio.gain.write')
      }
    };
  }

  async getChannels(): Promise<AudioChannel[]> {
    const channels: AudioChannel[] = [];
    this.headampChannelIds.clear();

    for (let index = 1; index <= 32; index += 1) {
      const path = channelPath(index);
      const [nameReply, faderReply, onReply, panReply, sourceReply] =
        await Promise.all([
          this.transport.request(`${path}/config/name`),
          this.transport.request(`${path}/mix/fader`),
          this.transport.request(`${path}/mix/on`),
          this.transport.request(`${path}/mix/pan`),
          this.transport.request(`${path}/config/source`)
        ]);

      const rawFader = firstNumber(faderReply) ?? 0;
      const rawOn = firstNumber(onReply) ?? 0;
      const rawPan = firstNumber(panReply) ?? 0.5;
      const sourceIndex = firstNumber(sourceReply);
      const headampIndex =
        sourceIndex === undefined
          ? undefined
          : resolveX32HeadampIndex(sourceIndex);
      const channelId = `ch-${String(index).padStart(2, '0')}`;
      if (headampIndex !== undefined) {
        this.rememberHeadampChannel(headampIndex, channelId);
      }

      let gainDb: number | undefined;
      let phantom: boolean | undefined;
      if (
        headampIndex !== undefined &&
        this.capabilitySet.has('audio.gain.write')
      ) {
        const [gainReply, phantomReply] = await Promise.all([
          this.transport.request(`${headampPath(headampIndex)}/gain`),
          this.transport.request(`${headampPath(headampIndex)}/phantom`)
        ]);
        const gain = firstNumber(gainReply);
        const phantomValue = firstNumber(phantomReply);
        gainDb =
          gain === undefined
            ? undefined
            : normalizedToHeadampGain(gain);
        phantom =
          phantomValue === undefined
            ? undefined
            : phantomValue >= 0.5;
      }

      channels.push({
        id: channelId,
        name: firstString(nameReply)?.trim() || `CH ${index}`,
        index,
        faderDb: x32LevelToDb(rawFader),
        mute: rawOn < 0.5,
        pan: rawPan * 2 - 1,
        gainDb,
        phantom,
        metadata: {
          sourceIndex,
          headampIndex,
          headampControllable: headampIndex !== undefined
        }
      });
    }

    return channels;
  }

  async getChannelProcessing(
    channelId: string
  ): Promise<AudioChannelProcessingState> {
    const index = this.parseChannelId(channelId);
    const path = channelPath(index);

    const sourceReply = await this.transport.request(
      `${path}/config/source`
    );
    const sourceIndex = firstNumber(sourceReply);
    const headampIndex =
      sourceIndex === undefined
        ? undefined
        : resolveX32HeadampIndex(sourceIndex);

    if (headampIndex !== undefined) {
      this.rememberHeadampChannel(headampIndex, channelId);
    }

    const [
      eqOn,
      gateOn,
      gateThr,
      gateRange,
      gateAttack,
      gateHold,
      gateRelease,
      dynOn,
      dynThr,
      dynRatio,
      dynKnee,
      dynMakeup,
      dynAttack,
      dynHold,
      dynRelease,
      dynMix,
      dynAuto
    ] = await Promise.all([
      this.transport.request(`${path}/eq/on`),
      this.transport.request(`${path}/gate/on`),
      this.transport.request(`${path}/gate/thr`),
      this.transport.request(`${path}/gate/range`),
      this.transport.request(`${path}/gate/attack`),
      this.transport.request(`${path}/gate/hold`),
      this.transport.request(`${path}/gate/release`),
      this.transport.request(`${path}/dyn/on`),
      this.transport.request(`${path}/dyn/thr`),
      this.transport.request(`${path}/dyn/ratio`),
      this.transport.request(`${path}/dyn/knee`),
      this.transport.request(`${path}/dyn/mgain`),
      this.transport.request(`${path}/dyn/attack`),
      this.transport.request(`${path}/dyn/hold`),
      this.transport.request(`${path}/dyn/release`),
      this.transport.request(`${path}/dyn/mix`),
      this.transport.request(`${path}/dyn/auto`)
    ]);

    const bands = await Promise.all(
      ([1, 2, 3, 4] as const).map(async band => {
        const [typeReply, frequencyReply, gainReply, qReply] =
          await Promise.all([
            this.transport.request(`${path}/eq/${band}/type`),
            this.transport.request(`${path}/eq/${band}/f`),
            this.transport.request(`${path}/eq/${band}/g`),
            this.transport.request(`${path}/eq/${band}/q`)
          ]);

        return {
          index: band,
          type: firstNumber(typeReply),
          frequencyHz: normalizedToLog(
            20,
            20000,
            firstNumber(frequencyReply) ?? 0
          ),
          gainDb: normalizedToLinear(
            -15,
            15,
            firstNumber(gainReply) ?? 0.5
          ),
          q: normalizedToQ(firstNumber(qReply) ?? 0.5)
        };
      })
    );

    let gainDb: number | undefined;
    let phantom: boolean | undefined;
    if (headampIndex !== undefined) {
      const [gainReply, phantomReply] = await Promise.all([
        this.transport.request(`${headampPath(headampIndex)}/gain`),
        this.transport.request(`${headampPath(headampIndex)}/phantom`)
      ]);
      const gain = firstNumber(gainReply);
      const phantomValue = firstNumber(phantomReply);
      gainDb =
        gain === undefined
          ? undefined
          : normalizedToHeadampGain(gain);
      phantom =
        phantomValue === undefined
          ? undefined
          : phantomValue >= 0.5;
    }

    const ratioIndex = Math.round(firstNumber(dynRatio) ?? 0);

    return {
      channelId,
      sourceIndex,
      headampIndex,
      gainDb,
      phantom,
      eq: {
        on: (firstNumber(eqOn) ?? 0) >= 0.5,
        bands
      },
      gate: {
        on: (firstNumber(gateOn) ?? 0) >= 0.5,
        thresholdDb: normalizedToLinear(
          -80,
          0,
          firstNumber(gateThr) ?? 0
        ),
        rangeDb: normalizedToLinear(
          3,
          60,
          firstNumber(gateRange) ?? 0
        ),
        attackMs: normalizedToLinear(
          0,
          120,
          firstNumber(gateAttack) ?? 0
        ),
        holdMs: normalizedToLog(
          0.02,
          2000,
          firstNumber(gateHold) ?? 0
        ),
        releaseMs: normalizedToLog(
          5,
          4000,
          firstNumber(gateRelease) ?? 0
        )
      },
      compressor: {
        on: (firstNumber(dynOn) ?? 0) >= 0.5,
        thresholdDb: normalizedToLinear(
          -60,
          0,
          firstNumber(dynThr) ?? 0
        ),
        ratio: indexToRatio(
          Math.max(0, Math.min(11, ratioIndex))
        ),
        knee: normalizedToLinear(
          0,
          5,
          firstNumber(dynKnee) ?? 0
        ),
        makeupGainDb: normalizedToLinear(
          0,
          24,
          firstNumber(dynMakeup) ?? 0
        ),
        attackMs: normalizedToLinear(
          0,
          120,
          firstNumber(dynAttack) ?? 0
        ),
        holdMs: normalizedToLog(
          0.02,
          2000,
          firstNumber(dynHold) ?? 0
        ),
        releaseMs: normalizedToLog(
          5,
          4000,
          firstNumber(dynRelease) ?? 0
        ),
        mixPercent: normalizedToLinear(
          0,
          100,
          firstNumber(dynMix) ?? 1
        ),
        auto: (firstNumber(dynAuto) ?? 0) >= 0.5
      }
    };
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

  async getRouting(): Promise<AudioRoutingState> {
    const assignments = await Promise.all(
      Array.from({ length: 32 }, async (_, offset) => {
        const index = offset + 1;
        const reply = await this.transport.request(
          `${channelPath(index)}/mix/st`
        );
        return {
          sourceId: `ch-${String(index).padStart(2, '0')}`,
          targetId: 'main-lr',
          enabled: (firstNumber(reply) ?? 0) >= 0.5
        };
      })
    );

    return { assignments };
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

  async setGain(
    channelId: string,
    valueDb: number
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const headampIndex = await this.resolveChannelHeadamp(channelId);
    const address = `${headampPath(headampIndex)}/gain`;
    const normalized = headampGainToNormalized(valueDb);
    const observedRaw = await this.writeNumberAndConfirm(
      address,
      { type: 'f', value: normalized }
    );

    return commandResult(
      this.providerInstanceId,
      channelId,
      { gainDb: normalizedToHeadampGain(observedRaw) },
      startedAt
    );
  }

  async setPhantom(
    channelId: string,
    value: boolean
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const headampIndex = await this.resolveChannelHeadamp(channelId);
    const address = `${headampPath(headampIndex)}/phantom`;
    const observedRaw = await this.writeNumberAndConfirm(
      address,
      { type: 'i', value: value ? 1 : 0 }
    );

    return commandResult(
      this.providerInstanceId,
      channelId,
      { phantom: observedRaw >= 0.5 },
      startedAt
    );
  }

  async setEq(
    channelId: string,
    eq: Record<string, unknown>
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const path = channelPath(index);
    let writes = 0;

    const on = booleanValue(eq.on, 'eq_on');
    if (on !== undefined) {
      await this.writeNumberAndConfirm(
        `${path}/eq/on`,
        { type: 'i', value: on ? 1 : 0 }
      );
      writes += 1;
    }

    if (eq.bands !== undefined) {
      if (!Array.isArray(eq.bands)) {
        throw new Error('x32_eq_bands_must_be_array');
      }

      for (const raw of eq.bands) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('x32_eq_band_invalid');
        }
        const band = raw as Record<string, unknown>;
        const bandIndex = integerValue(band.index, 'eq_band_index');
        if (
          bandIndex === undefined ||
          bandIndex < 1 ||
          bandIndex > 4
        ) {
          throw new Error('x32_eq_band_index_out_of_range');
        }
        const bandPath = `${path}/eq/${bandIndex}`;

        const type = integerValue(band.type, 'eq_type');
        if (type !== undefined) {
          if (type < 0 || type > 5) {
            throw new Error('x32_eq_type_out_of_range');
          }
          await this.writeNumberAndConfirm(
            `${bandPath}/type`,
            { type: 'i', value: type }
          );
          writes += 1;
        }

        const frequencyHz = numberValue(
          band.frequencyHz,
          'eq_frequency'
        );
        if (frequencyHz !== undefined) {
          await this.writeNumberAndConfirm(
            `${bandPath}/f`,
            {
              type: 'f',
              value: logToNormalized(
                20,
                20000,
                frequencyHz,
                'eq_frequency'
              )
            }
          );
          writes += 1;
        }

        const gainDb = numberValue(band.gainDb, 'eq_gain');
        if (gainDb !== undefined) {
          await this.writeNumberAndConfirm(
            `${bandPath}/g`,
            {
              type: 'f',
              value: linearToNormalized(
                -15,
                15,
                gainDb,
                'eq_gain'
              )
            }
          );
          writes += 1;
        }

        const q = numberValue(band.q, 'eq_q');
        if (q !== undefined) {
          await this.writeNumberAndConfirm(
            `${bandPath}/q`,
            { type: 'f', value: qToNormalized(q) }
          );
          writes += 1;
        }
      }
    }

    if (writes === 0) throw new Error('x32_eq_no_supported_fields');
    const observed = await this.getChannelProcessing(channelId);

    return commandResult(
      this.providerInstanceId,
      channelId,
      { eq: observed.eq },
      startedAt
    );
  }

  async setGate(
    channelId: string,
    gate: Record<string, unknown>
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const path = `${channelPath(index)}/gate`;
    let writes = 0;

    const definitions: Array<{
      key: string;
      address: string;
      convert: (value: number) => number;
    }> = [
      {
        key: 'thresholdDb',
        address: 'thr',
        convert: value =>
          linearToNormalized(-80, 0, value, 'gate_threshold')
      },
      {
        key: 'rangeDb',
        address: 'range',
        convert: value =>
          linearToNormalized(3, 60, value, 'gate_range')
      },
      {
        key: 'attackMs',
        address: 'attack',
        convert: value =>
          linearToNormalized(0, 120, value, 'gate_attack')
      },
      {
        key: 'holdMs',
        address: 'hold',
        convert: value =>
          logToNormalized(0.02, 2000, value, 'gate_hold')
      },
      {
        key: 'releaseMs',
        address: 'release',
        convert: value =>
          logToNormalized(5, 4000, value, 'gate_release')
      }
    ];

    const on = booleanValue(gate.on, 'gate_on');
    if (on !== undefined) {
      await this.writeNumberAndConfirm(
        `${path}/on`,
        { type: 'i', value: on ? 1 : 0 }
      );
      writes += 1;
    }

    for (const definition of definitions) {
      const value = numberValue(
        gate[definition.key],
        `gate_${definition.key}`
      );
      if (value === undefined) continue;
      await this.writeNumberAndConfirm(
        `${path}/${definition.address}`,
        { type: 'f', value: definition.convert(value) }
      );
      writes += 1;
    }

    if (writes === 0) throw new Error('x32_gate_no_supported_fields');
    const observed = await this.getChannelProcessing(channelId);

    return commandResult(
      this.providerInstanceId,
      channelId,
      { gate: observed.gate },
      startedAt
    );
  }

  async setCompressor(
    channelId: string,
    compressor: Record<string, unknown>
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const index = this.parseChannelId(channelId);
    const path = `${channelPath(index)}/dyn`;
    let writes = 0;

    const on = booleanValue(compressor.on, 'compressor_on');
    if (on !== undefined) {
      await this.writeNumberAndConfirm(
        `${path}/on`,
        { type: 'i', value: on ? 1 : 0 }
      );
      writes += 1;
    }

    const ratio = numberValue(compressor.ratio, 'compressor_ratio');
    if (ratio !== undefined) {
      await this.writeNumberAndConfirm(
        `${path}/ratio`,
        { type: 'i', value: ratioToIndex(ratio) }
      );
      writes += 1;
    }

    const definitions: Array<{
      key: string;
      address: string;
      convert: (value: number) => number;
    }> = [
      {
        key: 'thresholdDb',
        address: 'thr',
        convert: value =>
          linearToNormalized(-60, 0, value, 'compressor_threshold')
      },
      {
        key: 'knee',
        address: 'knee',
        convert: value =>
          linearToNormalized(0, 5, value, 'compressor_knee')
      },
      {
        key: 'makeupGainDb',
        address: 'mgain',
        convert: value =>
          linearToNormalized(0, 24, value, 'compressor_makeup')
      },
      {
        key: 'attackMs',
        address: 'attack',
        convert: value =>
          linearToNormalized(0, 120, value, 'compressor_attack')
      },
      {
        key: 'holdMs',
        address: 'hold',
        convert: value =>
          logToNormalized(0.02, 2000, value, 'compressor_hold')
      },
      {
        key: 'releaseMs',
        address: 'release',
        convert: value =>
          logToNormalized(5, 4000, value, 'compressor_release')
      },
      {
        key: 'mixPercent',
        address: 'mix',
        convert: value =>
          linearToNormalized(0, 100, value, 'compressor_mix')
      }
    ];

    for (const definition of definitions) {
      const value = numberValue(
        compressor[definition.key],
        `compressor_${definition.key}`
      );
      if (value === undefined) continue;
      await this.writeNumberAndConfirm(
        `${path}/${definition.address}`,
        { type: 'f', value: definition.convert(value) }
      );
      writes += 1;
    }

    const auto = booleanValue(compressor.auto, 'compressor_auto');
    if (auto !== undefined) {
      await this.writeNumberAndConfirm(
        `${path}/auto`,
        { type: 'i', value: auto ? 1 : 0 }
      );
      writes += 1;
    }

    if (writes === 0) {
      throw new Error('x32_compressor_no_supported_fields');
    }
    const observed = await this.getChannelProcessing(channelId);

    return commandResult(
      this.providerInstanceId,
      channelId,
      { compressor: observed.compressor },
      startedAt
    );
  }

  async setBusSend(
    channelId: string,
    busId: string,
    valueDb: number
  ): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const channelIndex = this.parseChannelId(channelId);
    const busMatch = /^bus-(\d{2})$/.exec(busId);
    const busIndex = busMatch ? Number(busMatch[1]) : Number.NaN;

    if (!Number.isInteger(busIndex) || busIndex < 1 || busIndex > 16) {
      throw new Error(`invalid_x32_bus_id:${busId}`);
    }

    const address =
      `${channelPath(channelIndex)}/mix/${String(busIndex).padStart(2, '0')}/level`;
    const normalized = dbToX32Level(valueDb);

    await this.transport.send(address, [
      { type: 'f', value: normalized }
    ]);
    const reply = await this.transport.request(address);
    const observed = x32LevelToDb(
      firstNumber(reply) ?? normalized
    );

    return commandResult(
      this.providerInstanceId,
      channelId,
      {
        busId,
        valueDb: observed
      },
      startedAt
    );
  }

  async loadScene(sceneId: string): Promise<AudioCommandResult> {
    const startedAt = Date.now();
    const sceneIndex = parseSceneId(sceneId);

    await this.transport.send('/-snap/load', [
      { type: 'i', value: sceneIndex }
    ]);
    await delay(250);

    const observed = firstNumber(
      await this.transport.request('/-show/prepos/current', [], 1000)
    );

    if (observed !== sceneIndex) {
      return {
        accepted: false,
        providerInstanceId: this.providerInstanceId,
        targetId: sceneId,
        observedState: {
          requestedSceneIndex: sceneIndex,
          observedSceneIndex: observed
        },
        latencyMs: Math.max(0, Date.now() - startedAt),
        errorCode: 'x32_scene_recall_not_observed',
        recoverable: true
      };
    }

    return commandResult(
      this.providerInstanceId,
      sceneId,
      {
        sceneId,
        sceneIndex,
        observedSceneIndex: observed
      },
      startedAt
    );
  }

  async *subscribeState(
    scope: AudioSubscriptionScope = {}
  ): AsyncIterable<AudioStatePatch> {
    const renewRemote = async () => {
      await this.transport.send('/xremote');
    };

    await renewRemote();
    const renew = setInterval(() => {
      void renewRemote();
    }, 8000);

    try {
      for await (const message of this.transport.messages(scope.signal)) {
        const channel = /^\/ch\/(\d{2})\/(mix\/(fader|on|pan|st)|mix\/(\d{2})\/level|config\/name|(eq|gate|dyn)\/.+)$/.exec(
          message.address
        );
        if (channel) {
          const index = Number(channel[1]);
          const channelId = `ch-${String(index).padStart(2, '0')}`;
          if (scope.channelIds?.length && !scope.channelIds.includes(channelId)) {
            continue;
          }

          const leaf = channel[2] ?? '';
          let patch: Record<string, unknown> | undefined;
          if (leaf === 'mix/fader') {
            const value = firstNumber(message);
            if (value !== undefined) patch = { faderDb: x32LevelToDb(value) };
          } else if (leaf === 'mix/on') {
            const value = firstNumber(message);
            if (value !== undefined) patch = { mute: value < 0.5 };
          } else if (leaf === 'mix/pan') {
            const value = firstNumber(message);
            if (value !== undefined) patch = { pan: value * 2 - 1 };
          } else if (leaf === 'mix/st') {
            const value = firstNumber(message);
            if (value !== undefined) {
              patch = { assignedToMain: value >= 0.5 };
            }
          } else if (/^mix\/\d{2}\/level$/.test(leaf)) {
            const value = firstNumber(message);
            if (value !== undefined) {
              const busIndex = Number(channel[4]);
              patch = {
                busSend: {
                  busId: `bus-${String(busIndex).padStart(2, '0')}`,
                  valueDb: x32LevelToDb(value)
                }
              };
            }
          } else if (leaf === 'config/name') {
            const value = firstString(message);
            if (value !== undefined) patch = { name: value.trim() };
          } else if (
            leaf.startsWith('eq/') ||
            leaf.startsWith('gate/') ||
            leaf.startsWith('dyn/')
          ) {
            patch = { processingDirty: true };
          }

          if (patch) {
            yield {
              providerInstanceId: this.providerInstanceId,
              sequence: ++this.meterSequence,
              capturedAt: Date.now(),
              scope: 'channel',
              targetId: channelId,
              patch
            };
          }
          continue;
        }

        const headamp = /^\/headamp\/(\d{3})\/(gain|phantom)$/.exec(
          message.address
        );
        if (headamp) {
          const headampIndex = Number(headamp[1]);
          const value = firstNumber(message);
          const channelIds = this.headampChannelIds.get(headampIndex);
          if (value !== undefined && channelIds) {
            for (const channelId of channelIds) {
              if (
                scope.channelIds?.length &&
                !scope.channelIds.includes(channelId)
              ) {
                continue;
              }
              yield {
                providerInstanceId: this.providerInstanceId,
                sequence: ++this.meterSequence,
                capturedAt: Date.now(),
                scope: 'channel',
                targetId: channelId,
                patch:
                  headamp[2] === 'gain'
                    ? { gainDb: normalizedToHeadampGain(value) }
                    : { phantom: value >= 0.5 }
              };
            }
          }
          continue;
        }

        const dca = /^\/dca\/(\d)\/(fader|on|config\/name)$/.exec(
          message.address
        );
        if (dca) {
          const id = `dca-${dca[1]}`;
          const leaf = dca[2];
          const number = firstNumber(message);
          const text = firstString(message);
          const patch =
            leaf === 'fader' && number !== undefined
              ? { faderDb: x32LevelToDb(number) }
              : leaf === 'on' && number !== undefined
                ? { mute: number < 0.5 }
                : leaf === 'config/name' && text !== undefined
                  ? { name: text.trim() }
                  : undefined;

          if (patch) {
            yield {
              providerInstanceId: this.providerInstanceId,
              sequence: ++this.meterSequence,
              capturedAt: Date.now(),
              scope: 'group',
              targetId: id,
              patch
            };
          }
        }
      }
    } finally {
      clearInterval(renew);
    }
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

  private async resolveChannelHeadamp(channelId: string): Promise<number> {
    const index = this.parseChannelId(channelId);
    const source = firstNumber(
      await this.transport.request(
        `${channelPath(index)}/config/source`
      )
    );
    const headampIndex =
      source === undefined
        ? undefined
        : resolveX32HeadampIndex(source);

    if (headampIndex === undefined) {
      throw new Error(
        `x32_channel_source_has_no_controllable_headamp:${channelId}:${source ?? 'unknown'}`
      );
    }

    this.rememberHeadampChannel(headampIndex, channelId);
    return headampIndex;
  }

  private rememberHeadampChannel(
    headampIndex: number,
    channelId: string
  ): void {
    const current =
      this.headampChannelIds.get(headampIndex) ?? new Set<string>();
    current.add(channelId);
    this.headampChannelIds.set(headampIndex, current);
  }

  private async writeNumberAndConfirm(
    address: string,
    arg: Extract<OscArgument, { type: 'f' | 'i' }>
  ): Promise<number> {
    await this.transport.send(address, [arg]);
    const reply = await this.transport.request(address);
    const observed = firstNumber(reply);
    if (observed === undefined) {
      throw new Error(`x32_write_not_observed:${address}`);
    }
    return observed;
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
