import type {
  AudioChannel,
  MeterFrame,
  MeterValue
} from '@millionsnest/nestlive-domain';

export interface MixChannelViewModel {
  id: string;
  name: string;
  index: number;
  faderDb: number;
  mute: boolean;
  meterDb: number;
  peakDb: number;
  clip: boolean;
  meterAvailable: boolean;
}

function findMeter(
  frame: MeterFrame | undefined,
  channelId: string
): MeterValue | undefined {
  return frame?.channels.find(item => item.id === channelId);
}

export function buildMixChannelViewModels(
  channels: AudioChannel[],
  frame?: MeterFrame
): MixChannelViewModel[] {
  return channels.map(channel => {
    const meter = findMeter(frame, channel.id);
    return {
      id: channel.id,
      name: channel.name,
      index: channel.index,
      faderDb: channel.faderDb ?? -96,
      mute: channel.mute ?? false,
      meterDb:
        meter?.postFaderDb ??
        meter?.peakDb ??
        meter?.rmsDb ??
        meter?.preFaderDb ??
        -96,
      peakDb: meter?.peakDb ?? -96,
      clip: meter?.clip ?? false,
      meterAvailable: Boolean(meter)
    };
  });
}

export function meterPercent(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 100;
  return ((db + 60) / 60) * 100;
}

export function meterStatusText(input: {
  db: number;
  clip: boolean;
  available: boolean;
  stale: boolean;
}): string {
  if (input.stale) return 'Telemetria congelada';
  if (!input.available) return 'Meter indisponível';
  if (input.clip || input.db >= 0) return 'Clip';
  if (input.db >= -3) return 'Próximo do clip';
  if (input.db >= -9) return 'Forte';
  if (input.db >= -24) return 'Sinal saudável';
  if (input.db >= -50) return 'Sinal baixo';
  return 'Sem sinal';
}
