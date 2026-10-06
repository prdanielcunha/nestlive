import {
  CAPABILITIES,
  type Capability,
  type ProviderKind
} from './types';

export type AdapterTransport =
  | 'http'
  | 'websocket'
  | 'tcp'
  | 'udp'
  | 'native-bridge';

export type ProductionAdapterKey =
  | 'obs-websocket'
  | 'companion'
  | 'osc'
  | 'midi'
  | 'atem'
  | 'vmix'
  | 'artnet-dmx';

export type AdapterSetupFieldKind =
  | 'host'
  | 'port'
  | 'url'
  | 'secret'
  | 'text'
  | 'number'
  | 'boolean';

export interface AdapterSetupField {
  key: string;
  label: string;
  kind: AdapterSetupFieldKind;
  required: boolean;
  advanced?: boolean;
  secret?: boolean;
  defaultValue?: string | number | boolean;
  help?: string;
}

export interface AdapterManifest {
  schemaVersion: 1;
  adapterKey: ProductionAdapterKey;
  displayName: string;
  providerKind: ProviderKind;
  transport: AdapterTransport;
  capabilities: Capability[];
  setup: AdapterSetupField[];
  observedStateKeys: string[];
  requiresLocalNode: true;
  secretsStayLocal: true;
  supportsOutputTargeting: boolean;
  experimental?: boolean;
}

export interface AdapterSdkContext {
  nodeId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
}

export interface AdapterSdkRegistration {
  manifest: AdapterManifest;
  instanceId: string;
  displayName: string;
  config: Record<string, unknown>;
}

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

function safeKey(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(value);
}

export function defineAdapterManifest(
  manifest: AdapterManifest
): AdapterManifest {
  if (!manifest.displayName.trim()) {
    throw new Error('adapter_display_name_required');
  }
  if (!safeKey(manifest.adapterKey)) {
    throw new Error('adapter_key_invalid');
  }

  const capabilities = [...new Set(manifest.capabilities)];
  if (
    capabilities.length !== manifest.capabilities.length ||
    capabilities.some(capability => !isCapability(capability))
  ) {
    throw new Error('adapter_capabilities_invalid');
  }

  const fieldKeys = manifest.setup.map(field => field.key);
  if (
    new Set(fieldKeys).size !== fieldKeys.length ||
    fieldKeys.some(key => !safeKey(key))
  ) {
    throw new Error('adapter_setup_invalid');
  }

  for (const field of manifest.setup) {
    if (field.kind === 'secret' && field.secret !== true) {
      throw new Error('adapter_secret_field_must_be_marked');
    }
  }

  return Object.freeze({
    ...manifest,
    capabilities: Object.freeze([...capabilities]) as Capability[],
    setup: Object.freeze(
      manifest.setup.map(field => Object.freeze({ ...field }))
    ) as AdapterSetupField[],
    observedStateKeys: Object.freeze(
      [...new Set(manifest.observedStateKeys)]
    ) as string[]
  });
}

export function validateAdapterRegistration(
  registration: AdapterSdkRegistration
): void {
  if (!safeKey(registration.instanceId)) {
    throw new Error('adapter_instance_id_invalid');
  }
  if (!registration.displayName.trim()) {
    throw new Error('adapter_instance_name_required');
  }

  const allowed = new Set(registration.manifest.setup.map(field => field.key));
  const supplied = Object.keys(registration.config);
  if (supplied.some(key => !allowed.has(key))) {
    throw new Error('adapter_config_unknown_field');
  }

  for (const field of registration.manifest.setup) {
    const value = registration.config[field.key];
    if (field.required && (value === undefined || value === null || value === '')) {
      throw new Error(`adapter_config_required:${field.key}`);
    }
  }
}

export function publicAdapterConfig(
  registration: AdapterSdkRegistration
): Record<string, unknown> {
  const secretKeys = new Set(
    registration.manifest.setup
      .filter(field => field.secret || field.kind === 'secret')
      .map(field => field.key)
  );

  return Object.fromEntries(
    Object.entries(registration.config).map(([key, value]) => [
      key,
      secretKeys.has(key) ? '[stored-in-os-vault]' : value
    ])
  );
}
