export type EntityId = string;

export type NetworkInterfaceType =
  | 'ethernet'
  | 'wifi'
  | 'usb_wifi'
  | 'virtual'
  | 'other';

export type NetworkInterfacePurpose =
  | 'cloud'
  | 'production'
  | 'audio_control'
  | 'media'
  | 'custom';

export type NetworkHealth = 'online' | 'degraded' | 'offline' | 'unknown';

export interface NetworkInterface {
  id: EntityId;
  nodeId: EntityId;
  systemName: string;
  humanName: string;
  type: NetworkInterfaceType;
  ipv4: string[];
  ipv6: string[];
  subnet: string[];
  gateway: string[];
  dns: string[];
  macAddress?: string;
  status: NetworkHealth;
  purpose?: NetworkInterfacePurpose;
  metric?: number;
  lastSeenAt: string;
}

export interface ProviderNetworkBinding {
  providerInstanceId: EntityId;
  networkInterfaceId: EntityId;
  localAddress: string;
  targetAddress: string;
  transport: 'udp' | 'tcp' | 'http' | 'https' | 'websocket' | 'other';
  discoveryMethod: 'automatic' | 'manual' | 'cached';
  lastValidatedAt: string;
  health: NetworkHealth;
}

export const AUDIO_CAPABILITIES = [
  'audio.console.state.read',
  'audio.channel.read',
  'audio.bus.read',
  'audio.group.read',
  'audio.routing.read',
  'audio.meter.read',
  'audio.fader.write',
  'audio.mute.write',
  'audio.pan.write',
  'audio.gain.write',
  'audio.phantom.write',
  'audio.eq.write',
  'audio.gate.write',
  'audio.compressor.write',
  'audio.busSend.write',
  'audio.scene.read',
  'audio.scene.save',
  'audio.scene.recall'
] as const;

export type AudioCapability = (typeof AUDIO_CAPABILITIES)[number];
export type AudioCapabilitySet = ReadonlySet<AudioCapability>;
export type AudioSafetyLevel = 'normal' | 'guarded' | 'critical';

export interface AudioCommandResult {
  accepted: boolean;
  providerInstanceId: EntityId;
  targetId?: EntityId;
  observedState?: Record<string, unknown>;
  latencyMs: number;
  errorCode?: string;
  recoverable?: boolean;
}

export interface AudioChannel {
  id: EntityId;
  name: string;
  index: number;
  faderDb?: number;
  mute?: boolean;
  pan?: number;
  gainDb?: number;
  phantom?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AudioBus {
  id: EntityId;
  name: string;
  index: number;
  faderDb?: number;
  mute?: boolean;
}

export interface AudioGroup {
  id: EntityId;
  name: string;
  index: number;
  faderDb?: number;
  mute?: boolean;
  memberIds?: EntityId[];
}

export interface AudioRoutingState {
  assignments: Array<{
    sourceId: EntityId;
    targetId: EntityId;
    enabled: boolean;
  }>;
}

export interface AudioConsoleState {
  providerInstanceId: EntityId;
  model?: string;
  firmware?: string;
  connected: boolean;
  updatedAt: number;
  observed: Record<string, unknown>;
}

export interface AudioStatePatch {
  providerInstanceId: EntityId;
  sequence: number;
  capturedAt: number;
  scope: 'console' | 'channel' | 'bus' | 'group' | 'routing';
  targetId?: EntityId;
  patch: Record<string, unknown>;
}

export interface MeterValue {
  id: EntityId;
  preFaderDb?: number;
  postFaderDb?: number;
  peakDb?: number;
  rmsDb?: number;
  gainReductionDb?: number;
  gateOpen?: boolean;
  clip?: boolean;
}

export interface MeterFrame {
  providerInstanceId: EntityId;
  sequence: number;
  capturedAt: number;
  channels: MeterValue[];
  buses?: MeterValue[];
  mains?: MeterValue[];
}

export interface AudioSubscriptionScope {
  channelIds?: EntityId[];
  busIds?: EntityId[];
  includeMains?: boolean;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface AudioConsoleProvider {
  readonly providerInstanceId: EntityId;

  capabilities(): AudioCapabilitySet;

  getConsoleState(): Promise<AudioConsoleState>;
  getChannels(): Promise<AudioChannel[]>;
  getBuses(): Promise<AudioBus[]>;
  getGroups(): Promise<AudioGroup[]>;
  getRouting?(): Promise<AudioRoutingState>;

  subscribeState?(scope?: AudioSubscriptionScope): AsyncIterable<AudioStatePatch>;
  subscribeMeters?(scope?: AudioSubscriptionScope): AsyncIterable<MeterFrame>;

  setFader?(channelId: EntityId, valueDb: number): Promise<AudioCommandResult>;
  setMute?(channelId: EntityId, value: boolean): Promise<AudioCommandResult>;
  setPan?(channelId: EntityId, value: number): Promise<AudioCommandResult>;
  setGain?(channelId: EntityId, valueDb: number): Promise<AudioCommandResult>;
  setPhantom?(channelId: EntityId, value: boolean): Promise<AudioCommandResult>;

  setEq?(channelId: EntityId, eq: Record<string, unknown>): Promise<AudioCommandResult>;
  setGate?(channelId: EntityId, gate: Record<string, unknown>): Promise<AudioCommandResult>;
  setCompressor?(
    channelId: EntityId,
    compressor: Record<string, unknown>
  ): Promise<AudioCommandResult>;
  setBusSend?(
    channelId: EntityId,
    busId: EntityId,
    valueDb: number
  ): Promise<AudioCommandResult>;

  loadScene?(sceneId: EntityId): Promise<AudioCommandResult>;
  saveScene?(name: string): Promise<AudioCommandResult>;
  dispose?(): Promise<void>;
}

export const AUDIO_SAFETY_BY_CAPABILITY: Readonly<
  Partial<Record<AudioCapability, AudioSafetyLevel>>
> = {
  'audio.fader.write': 'normal',
  'audio.pan.write': 'normal',
  'audio.busSend.write': 'normal',
  'audio.mute.write': 'guarded',
  'audio.eq.write': 'guarded',
  'audio.gate.write': 'guarded',
  'audio.compressor.write': 'guarded',
  'audio.gain.write': 'guarded',
  'audio.phantom.write': 'critical',
  'audio.scene.recall': 'critical'
};
