import {
  defineAdapterManifest,
  type AdapterManifest
} from '@millionsnest/nestlive-production-domain';

export const PRODUCTION_ADAPTER_MANIFESTS = {
  obs: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'obs-websocket',
    displayName: 'OBS Studio',
    providerKind: 'broadcast',
    transport: 'websocket',
    capabilities: [
      'presentation.preview',
      'presentation.take',
      'presentation.clear',
      'automation.trigger'
    ],
    setup: [
      { key: 'url', label: 'OBS WebSocket URL', kind: 'url', required: true, defaultValue: 'ws://127.0.0.1:4455' },
      { key: 'password', label: 'OBS WebSocket password', kind: 'secret', required: true, secret: true }
    ],
    observedStateKeys: ['programScene', 'previewScene', 'streaming', 'recording'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  companion: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'companion',
    displayName: 'Bitfocus Companion',
    providerKind: 'control',
    transport: 'native-bridge',
    capabilities: ['automation.trigger'],
    setup: [
      { key: 'baseUrl', label: 'Companion bridge URL', kind: 'url', required: true }
    ],
    observedStateKeys: ['bridge', 'version'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  osc: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'osc',
    displayName: 'Open Sound Control',
    providerKind: 'control',
    transport: 'udp',
    capabilities: ['automation.trigger', 'audio.route.write'],
    setup: [
      { key: 'host', label: 'OSC host', kind: 'host', required: true },
      { key: 'port', label: 'OSC UDP port', kind: 'port', required: true, defaultValue: 8000 }
    ],
    observedStateKeys: ['host', 'port'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  midi: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'midi',
    displayName: 'MIDI',
    providerKind: 'control',
    transport: 'native-bridge',
    capabilities: ['automation.trigger', 'audio.route.write'],
    setup: [
      { key: 'baseUrl', label: 'MIDI bridge URL', kind: 'url', required: true },
      { key: 'device', label: 'MIDI device alias', kind: 'text', required: false }
    ],
    observedStateKeys: ['device', 'bridge'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  atem: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'atem',
    displayName: 'Blackmagic ATEM',
    providerKind: 'broadcast',
    transport: 'native-bridge',
    capabilities: [
      'presentation.preview',
      'presentation.take',
      'presentation.clear',
      'automation.trigger'
    ],
    setup: [
      { key: 'baseUrl', label: 'ATEM SDK bridge URL', kind: 'url', required: true }
    ],
    observedStateKeys: ['programInput', 'previewInput', 'transition', 'bridge'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  vmix: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'vmix',
    displayName: 'vMix',
    providerKind: 'broadcast',
    transport: 'http',
    capabilities: [
      'presentation.preview',
      'presentation.take',
      'presentation.clear',
      'automation.trigger'
    ],
    setup: [
      { key: 'baseUrl', label: 'vMix Web API URL', kind: 'url', required: true, defaultValue: 'http://127.0.0.1:8088' }
    ],
    observedStateKeys: ['version', 'active', 'preview', 'streaming', 'recording'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  }),
  artnetDmx: defineAdapterManifest({
    schemaVersion: 1,
    adapterKey: 'artnet-dmx',
    displayName: 'Art-Net / DMX',
    providerKind: 'control',
    transport: 'udp',
    capabilities: ['automation.trigger'],
    setup: [
      { key: 'host', label: 'Art-Net node', kind: 'host', required: true },
      { key: 'port', label: 'Art-Net UDP port', kind: 'port', required: true, defaultValue: 6454 },
      { key: 'universe', label: 'Default universe', kind: 'number', required: false, defaultValue: 0 }
    ],
    observedStateKeys: ['host', 'port', 'lastUniverse', 'sequence'],
    requiresLocalNode: true,
    secretsStayLocal: true,
    supportsOutputTargeting: false
  })
} satisfies Record<string, AdapterManifest>;

export type ProductionAdapterName = keyof typeof PRODUCTION_ADAPTER_MANIFESTS;
