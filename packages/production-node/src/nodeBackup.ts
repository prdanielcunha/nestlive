import { createHash, randomUUID } from 'node:crypto';
import type {
  AudioProfile,
  LiveNodeBackupManifest,
  LiveTemplate,
  ProviderLink,
  ProviderRouteGroup,
  Scene,
  ServicePlan,
  SignalTopology
} from '@millionsnest/nestlive-production-domain';

export interface LiveNodeBackupBundle {
  schemaVersion: 1;
  manifest: LiveNodeBackupManifest;
  data: {
    servicePlan: ServicePlan | null;
    providerLinks: ProviderLink[];
    scenes: Scene[];
    routing: Partial<Record<ProviderRouteGroup, string>>;
    signalTopology: SignalTopology;
    audioProfiles: AudioProfile[];
    templates: LiveTemplate[];
  };
}

function section(value: unknown): {
  json: string;
  sha256: string;
  bytes: number;
} {
  const json = JSON.stringify(value);
  return {
    json,
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Buffer.byteLength(json)
  };
}

export function createLiveNodeBackup(input: {
  appVersion: string;
  nodeId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  servicePlan: ServicePlan | null;
  providerLinks: ProviderLink[];
  scenes: Scene[];
  routing: Partial<Record<ProviderRouteGroup, string>>;
  signalTopology: SignalTopology;
  audioProfiles: AudioProfile[];
  templates: LiveTemplate[];
  now?: Date;
}): LiveNodeBackupBundle {
  const data: LiveNodeBackupBundle['data'] = {
    servicePlan: input.servicePlan ? structuredClone(input.servicePlan) : null,
    providerLinks: structuredClone(input.providerLinks),
    scenes: structuredClone(input.scenes),
    routing: structuredClone(input.routing),
    signalTopology: structuredClone(input.signalTopology),
    audioProfiles: structuredClone(input.audioProfiles),
    templates: structuredClone(input.templates)
  };

  const files = Object.entries(data).map(([key, value]) => {
    const hashed = section(value);
    return {
      key,
      sha256: hashed.sha256,
      bytes: hashed.bytes,
      encrypted: false
    };
  });

  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      backupId: `backup:${randomUUID()}`,
      organizationId: input.organizationId,
      venueId: input.venueId,
      liveSystemId: input.liveSystemId,
      nodeId: input.nodeId,
      createdAt: (input.now || new Date()).toISOString(),
      appVersion: input.appVersion,
      servicePlanId: input.servicePlan?.id,
      files,
      secretsIncluded: false
    },
    data
  };
}

export function validateLiveNodeBackup(
  value: unknown,
  scope: {
    organizationId: string;
    venueId: string;
    liveSystemId: string;
  }
): LiveNodeBackupBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('backup_invalid');
  }
  const bundle = value as LiveNodeBackupBundle;
  if (bundle.schemaVersion !== 1 || bundle.manifest?.schemaVersion !== 1) {
    throw new Error('backup_version_unsupported');
  }
  if (bundle.manifest.secretsIncluded !== false) {
    throw new Error('backup_secret_payload_forbidden');
  }
  if (
    bundle.manifest.organizationId !== scope.organizationId ||
    bundle.manifest.venueId !== scope.venueId ||
    bundle.manifest.liveSystemId !== scope.liveSystemId
  ) {
    throw new Error('backup_scope_forbidden');
  }
  if (!bundle.data || typeof bundle.data !== 'object') {
    throw new Error('backup_data_missing');
  }

  const expected = new Map(
    (bundle.manifest.files || []).map(file => [file.key, file])
  );
  for (const [key, data] of Object.entries(bundle.data)) {
    const descriptor = expected.get(key);
    if (!descriptor) throw new Error(`backup_section_missing:${key}`);
    const hashed = section(data);
    if (
      descriptor.sha256 !== hashed.sha256 ||
      descriptor.bytes !== hashed.bytes
    ) {
      throw new Error(`backup_checksum_mismatch:${key}`);
    }
  }

  const plan = bundle.data.servicePlan;
  if (
    plan &&
    (
      plan.organizationId !== scope.organizationId ||
      plan.venueId !== scope.venueId ||
      plan.liveSystemId !== scope.liveSystemId
    )
  ) {
    throw new Error('backup_plan_scope_forbidden');
  }
  if (bundle.data.providerLinks.some(link =>
    link.organizationId !== scope.organizationId ||
    link.venueId !== scope.venueId
  )) {
    throw new Error('backup_provider_link_scope_forbidden');
  }
  if (bundle.data.scenes.some(scene =>
    scene.organizationId !== scope.organizationId ||
    scene.venueId !== scope.venueId ||
    (scene.liveSystemId && scene.liveSystemId !== scope.liveSystemId)
  )) {
    throw new Error('backup_scene_scope_forbidden');
  }

  return structuredClone(bundle);
}
