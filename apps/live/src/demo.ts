import type {
  AudioChannel,
  MeterFrame
} from '@millionsnest/nestlive-domain';

export const demoChannels: AudioChannel[] = [
  { id: 'ch-01', name: 'Pastor', index: 1, faderDb: -3, mute: false, gainDb: 24 },
  { id: 'ch-02', name: 'Vocal 1', index: 2, faderDb: -5, mute: false, gainDb: 22 },
  { id: 'ch-03', name: 'Vocal 2', index: 3, faderDb: -6, mute: false, gainDb: 21 },
  { id: 'ch-04', name: 'Violão', index: 4, faderDb: -7, mute: false, gainDb: 18 },
  { id: 'ch-05', name: 'Guitarra', index: 5, faderDb: -8, mute: false, gainDb: 16 },
  { id: 'ch-06', name: 'Teclas', index: 6, faderDb: -5, mute: false, gainDb: 14 },
  { id: 'ch-07', name: 'Baixo', index: 7, faderDb: -7, mute: false, gainDb: 17 },
  { id: 'ch-08', name: 'Playback', index: 8, faderDb: -4, mute: false }
];

export function createDemoFrame(tick: number): MeterFrame {
  return {
    providerInstanceId: 'demo-console',
    sequence: tick,
    capturedAt: Date.now(),
    channels: demoChannels.map((channel, index) => {
      const peakDb = -17 + Math.sin((tick + index * 5) / 7) * 11 - index;
      return {
        id: channel.id,
        preFaderDb: peakDb - 2,
        postFaderDb: peakDb + Math.min(0, channel.faderDb ?? 0),
        peakDb,
        rmsDb: peakDb - 6,
        gainReductionDb: index < 3 ? -2 : 0,
        gateOpen: peakDb > -40,
        clip: peakDb >= 0
      };
    }),
    mains: [
      {
        id: 'main-lr',
        peakDb: -7 + Math.sin(tick / 8) * 3,
        clip: false
      }
    ]
  };
}
