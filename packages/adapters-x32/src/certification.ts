export type X32CertificationResult =
  | 'pass'
  | 'fail'
  | 'unsupported'
  | 'untested';

export type X32DeepCapability =
  | 'audio.gain.write'
  | 'audio.phantom.write'
  | 'audio.eq.write'
  | 'audio.gate.write'
  | 'audio.compressor.write'
  | 'audio.scene.recall';

export interface X32CapabilityCertification {
  capability: X32DeepCapability;
  result: X32CertificationResult;
  evidence?: string;
  certifiedAt?: string;
}

export interface X32CertificationManifest {
  schemaVersion: 1;
  venueId: string;
  providerInstanceId: string;
  targetAddress?: string;
  model: string;
  firmware: string;
  capabilities: X32CapabilityCertification[];
  approvedBy?: string;
  approvedAt?: string;
}

const REQUIRED: readonly X32DeepCapability[] = [
  'audio.gain.write',
  'audio.phantom.write',
  'audio.eq.write',
  'audio.gate.write',
  'audio.compressor.write',
  'audio.scene.recall'
];

export function validateX32CertificationManifest(
  value: unknown
): X32CertificationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('x32_certification_manifest_invalid');
  }
  const manifest = value as Partial<X32CertificationManifest>;
  if (manifest.schemaVersion !== 1) {
    throw new Error('x32_certification_schema_invalid');
  }
  if (
    !manifest.venueId?.trim() ||
    !manifest.providerInstanceId?.trim() ||
    !manifest.model?.trim() ||
    !manifest.firmware?.trim() ||
    !Array.isArray(manifest.capabilities)
  ) {
    throw new Error('x32_certification_identity_incomplete');
  }

  const seen = new Set<string>();
  for (const item of manifest.capabilities) {
    if (!item || !REQUIRED.includes(item.capability)) {
      throw new Error('x32_certification_capability_invalid');
    }
    if (seen.has(item.capability)) {
      throw new Error('x32_certification_capability_duplicate');
    }
    seen.add(item.capability);
    if (!['pass', 'fail', 'unsupported', 'untested'].includes(item.result)) {
      throw new Error('x32_certification_result_invalid');
    }
    if (item.result === 'pass' && !item.evidence?.trim()) {
      throw new Error(
        `x32_certification_evidence_required:${item.capability}`
      );
    }
  }

  return manifest as X32CertificationManifest;
}

export function certifiedX32DeepCapabilities(
  manifest: X32CertificationManifest,
  input: {
    providerInstanceId: string;
    targetAddress: string;
    model?: string;
    firmware?: string;
  }
): ReadonlySet<X32DeepCapability> {
  if (manifest.providerInstanceId !== input.providerInstanceId) {
    return new Set();
  }
  if (
    manifest.targetAddress &&
    manifest.targetAddress !== input.targetAddress
  ) {
    return new Set();
  }
  if (
    !input.model ||
    !input.firmware ||
    manifest.model !== input.model ||
    manifest.firmware !== input.firmware
  ) {
    return new Set();
  }

  return new Set(
    manifest.capabilities
      .filter(item => item.result === 'pass' && item.evidence?.trim())
      .map(item => item.capability)
  );
}

export function allX32DeepControlsCertified(
  manifest: X32CertificationManifest,
  input: {
    providerInstanceId: string;
    targetAddress: string;
    model?: string;
    firmware?: string;
  }
): boolean {
  const certified = certifiedX32DeepCapabilities(manifest, input);
  return REQUIRED.every(capability => certified.has(capability));
}
