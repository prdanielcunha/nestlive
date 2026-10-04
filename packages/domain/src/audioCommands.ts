import type {
  AudioCapability,
  AudioCommandResult,
  AudioSafetyLevel,
  EntityId
} from './audio';

export type AudioControlCommand =
  | {
      type: 'setFader';
      channelId: EntityId;
      valueDb: number;
    }
  | {
      type: 'setMute';
      channelId: EntityId;
      value: boolean;
    }
  | {
      type: 'setPan';
      channelId: EntityId;
      value: number;
    }
  | {
      type: 'setGain';
      channelId: EntityId;
      valueDb: number;
    }
  | {
      type: 'setPhantom';
      channelId: EntityId;
      value: boolean;
    }
  | {
      type: 'setEq';
      channelId: EntityId;
      eq: Record<string, unknown>;
    }
  | {
      type: 'setGate';
      channelId: EntityId;
      gate: Record<string, unknown>;
    }
  | {
      type: 'setCompressor';
      channelId: EntityId;
      compressor: Record<string, unknown>;
    }
  | {
      type: 'setBusSend';
      channelId: EntityId;
      busId: EntityId;
      valueDb: number;
    }
  | {
      type: 'loadScene';
      sceneId: EntityId;
    };

export interface AudioCommandEnvelope {
  id: EntityId;
  actorId: EntityId;
  providerInstanceId: EntityId;
  createdAt: string;
  command: AudioControlCommand;
  confirmedSafetyLevel?: AudioSafetyLevel;
}

export interface AudioCommandExecution {
  envelope: AudioCommandEnvelope;
  capability: AudioCapability;
  safetyLevel: AudioSafetyLevel;
  result: AudioCommandResult;
}

export function capabilityForAudioCommand(
  command: AudioControlCommand
): AudioCapability {
  switch (command.type) {
    case 'setFader':
      return 'audio.fader.write';
    case 'setMute':
      return 'audio.mute.write';
    case 'setPan':
      return 'audio.pan.write';
    case 'setGain':
      return 'audio.gain.write';
    case 'setPhantom':
      return 'audio.phantom.write';
    case 'setEq':
      return 'audio.eq.write';
    case 'setGate':
      return 'audio.gate.write';
    case 'setCompressor':
      return 'audio.compressor.write';
    case 'setBusSend':
      return 'audio.busSend.write';
    case 'loadScene':
      return 'audio.scene.recall';
  }
}
