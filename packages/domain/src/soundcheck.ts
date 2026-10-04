import type { EntityId } from './audio';

export type SoundcheckState =
  | 'pending'
  | 'testing'
  | 'checked'
  | 'attention';

export interface SoundcheckChannel {
  channelId: EntityId;
  roleName: string;
  musicianName?: string;
  state: SoundcheckState;
  peakDb?: number;
  clipCount: number;
  checkedAt?: string;
  note?: string;
}

export interface SoundcheckSession {
  id: EntityId;
  serviceId?: EntityId;
  title: string;
  startedAt: string;
  channels: SoundcheckChannel[];
}

export function markSoundcheckChannel(
  session: SoundcheckSession,
  channelId: EntityId,
  state: SoundcheckState,
  now = new Date()
): SoundcheckSession {
  return {
    ...session,
    channels: session.channels.map(channel =>
      channel.channelId === channelId
        ? {
            ...channel,
            state,
            checkedAt:
              state === 'checked' ? now.toISOString() : channel.checkedAt
          }
        : channel
    )
  };
}

export function recordSoundcheckPeak(
  session: SoundcheckSession,
  channelId: EntityId,
  peakDb: number
): SoundcheckSession {
  return {
    ...session,
    channels: session.channels.map(channel =>
      channel.channelId === channelId
        ? {
            ...channel,
            peakDb:
              channel.peakDb === undefined
                ? peakDb
                : Math.max(channel.peakDb, peakDb),
            clipCount:
              channel.clipCount + (peakDb >= 0 ? 1 : 0),
            state:
              peakDb >= 0 && channel.state === 'checked'
                ? 'attention'
                : channel.state
          }
        : channel
    )
  };
}
