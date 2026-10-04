import type {
  AudioBus,
  AudioCapability,
  AudioChannel,
  AudioCommandResult,
  AudioConsoleProvider,
  AudioConsoleState,
  AudioGroup,
  AudioRoutingState,
  AudioStatePatch,
  AudioSubscriptionScope,
  MeterFrame
} from '@millionsnest/nestlive-domain';
import {
  certifiedCapabilities,
  type SoundcraftCertificationManifest
} from './certification';

export interface SoundcraftSiDriver {
  getConsoleState(): Promise<AudioConsoleState>;
  getChannels(): Promise<AudioChannel[]>;
  getBuses(): Promise<AudioBus[]>;
  getGroups(): Promise<AudioGroup[]>;
  getRouting?(): Promise<AudioRoutingState>;
  subscribeState?(scope?: AudioSubscriptionScope): AsyncIterable<AudioStatePatch>;
  subscribeMeters?(scope?: AudioSubscriptionScope): AsyncIterable<MeterFrame>;

  setFader?(channelId: string, valueDb: number): Promise<AudioCommandResult>;
  setMute?(channelId: string, value: boolean): Promise<AudioCommandResult>;
  setPan?(channelId: string, value: number): Promise<AudioCommandResult>;
  setGain?(channelId: string, valueDb: number): Promise<AudioCommandResult>;
  setPhantom?(channelId: string, value: boolean): Promise<AudioCommandResult>;
  setEq?(channelId: string, eq: Record<string, unknown>): Promise<AudioCommandResult>;
  setGate?(channelId: string, gate: Record<string, unknown>): Promise<AudioCommandResult>;
  setCompressor?(
    channelId: string,
    compressor: Record<string, unknown>
  ): Promise<AudioCommandResult>;
  setBusSend?(
    channelId: string,
    busId: string,
    valueDb: number
  ): Promise<AudioCommandResult>;
  loadScene?(sceneId: string): Promise<AudioCommandResult>;
  saveScene?(name: string): Promise<AudioCommandResult>;
  dispose?(): Promise<void>;
}

function requireCapability(
  capabilities: ReadonlySet<AudioCapability>,
  capability: AudioCapability
): void {
  if (!capabilities.has(capability)) {
    throw new Error(`soundcraft_capability_not_certified:${capability}`);
  }
}

export class SoundcraftSiProvider implements AudioConsoleProvider {
  readonly providerInstanceId: string;
  private readonly capabilitySet: ReadonlySet<AudioCapability>;

  constructor(
    providerInstanceId: string,
    private readonly driver: SoundcraftSiDriver,
    manifest: SoundcraftCertificationManifest
  ) {
    this.providerInstanceId = providerInstanceId;
    this.capabilitySet = certifiedCapabilities(manifest);
  }

  capabilities(): ReadonlySet<AudioCapability> {
    return this.capabilitySet;
  }

  getConsoleState(): Promise<AudioConsoleState> {
    requireCapability(this.capabilitySet, 'audio.console.state.read');
    return this.driver.getConsoleState();
  }

  getChannels(): Promise<AudioChannel[]> {
    requireCapability(this.capabilitySet, 'audio.channel.read');
    return this.driver.getChannels();
  }

  getBuses(): Promise<AudioBus[]> {
    requireCapability(this.capabilitySet, 'audio.bus.read');
    return this.driver.getBuses();
  }

  getGroups(): Promise<AudioGroup[]> {
    requireCapability(this.capabilitySet, 'audio.group.read');
    return this.driver.getGroups();
  }

  async getRouting(): Promise<AudioRoutingState> {
    requireCapability(this.capabilitySet, 'audio.routing.read');
    if (!this.driver.getRouting) throw new Error('soundcraft_driver_method_missing');
    return this.driver.getRouting();
  }

  subscribeState(scope?: AudioSubscriptionScope): AsyncIterable<AudioStatePatch> {
    if (!this.driver.subscribeState) {
      throw new Error('soundcraft_driver_method_missing');
    }
    return this.driver.subscribeState(scope);
  }

  subscribeMeters(scope?: AudioSubscriptionScope): AsyncIterable<MeterFrame> {
    requireCapability(this.capabilitySet, 'audio.meter.read');
    if (!this.driver.subscribeMeters) {
      throw new Error('soundcraft_driver_method_missing');
    }
    return this.driver.subscribeMeters(scope);
  }

  setFader(channelId: string, valueDb: number) {
    requireCapability(this.capabilitySet, 'audio.fader.write');
    if (!this.driver.setFader) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setFader(channelId, valueDb);
  }

  setMute(channelId: string, value: boolean) {
    requireCapability(this.capabilitySet, 'audio.mute.write');
    if (!this.driver.setMute) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setMute(channelId, value);
  }

  setPan(channelId: string, value: number) {
    requireCapability(this.capabilitySet, 'audio.pan.write');
    if (!this.driver.setPan) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setPan(channelId, value);
  }

  setGain(channelId: string, valueDb: number) {
    requireCapability(this.capabilitySet, 'audio.gain.write');
    if (!this.driver.setGain) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setGain(channelId, valueDb);
  }

  setPhantom(channelId: string, value: boolean) {
    requireCapability(this.capabilitySet, 'audio.phantom.write');
    if (!this.driver.setPhantom) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setPhantom(channelId, value);
  }

  setEq(channelId: string, eq: Record<string, unknown>) {
    requireCapability(this.capabilitySet, 'audio.eq.write');
    if (!this.driver.setEq) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setEq(channelId, eq);
  }

  setGate(channelId: string, gate: Record<string, unknown>) {
    requireCapability(this.capabilitySet, 'audio.gate.write');
    if (!this.driver.setGate) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setGate(channelId, gate);
  }

  setCompressor(channelId: string, compressor: Record<string, unknown>) {
    requireCapability(this.capabilitySet, 'audio.compressor.write');
    if (!this.driver.setCompressor) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setCompressor(channelId, compressor);
  }

  setBusSend(channelId: string, busId: string, valueDb: number) {
    requireCapability(this.capabilitySet, 'audio.busSend.write');
    if (!this.driver.setBusSend) throw new Error('soundcraft_driver_method_missing');
    return this.driver.setBusSend(channelId, busId, valueDb);
  }

  loadScene(sceneId: string) {
    requireCapability(this.capabilitySet, 'audio.scene.recall');
    if (!this.driver.loadScene) throw new Error('soundcraft_driver_method_missing');
    return this.driver.loadScene(sceneId);
  }

  saveScene(name: string) {
    requireCapability(this.capabilitySet, 'audio.scene.save');
    if (!this.driver.saveScene) throw new Error('soundcraft_driver_method_missing');
    return this.driver.saveScene(name);
  }

  async dispose(): Promise<void> {
    await this.driver.dispose?.();
  }
}
