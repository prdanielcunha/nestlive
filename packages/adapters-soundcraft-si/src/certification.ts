import {
  AUDIO_CAPABILITIES,
  type AudioCapability
} from '@millionsnest/nestlive-domain';

export type SoundcraftEvidenceStatus =
  | 'untested'
  | 'read_only'
  | 'read_write'
  | 'unsupported';

export interface SoundcraftCapabilityEvidence {
  capability: AudioCapability;
  status: SoundcraftEvidenceStatus;
  testedAt?: string;
  consoleModel?: string;
  firmware?: string;
  notes?: string;
  evidenceRef?: string;
}

export interface SoundcraftCertificationManifest {
  schemaVersion: 1;
  venue: string;
  consoleModel: 'Soundcraft Si Expression' | string;
  firmware?: string;
  testedAt?: string;
  tester?: string;
  capabilities: SoundcraftCapabilityEvidence[];
}

export function createEmptySoundcraftManifest(
  venue = 'Industrial'
): SoundcraftCertificationManifest {
  return {
    schemaVersion: 1,
    venue,
    consoleModel: 'Soundcraft Si Expression',
    capabilities: AUDIO_CAPABILITIES.map(capability => ({
      capability,
      status: 'untested'
    }))
  };
}

export function certifiedCapabilities(
  manifest: SoundcraftCertificationManifest
): ReadonlySet<AudioCapability> {
  return new Set(
    manifest.capabilities
      .filter(item => {
        if (item.capability.endsWith('.read')) {
          return item.status === 'read_only' || item.status === 'read_write';
        }
        return item.status === 'read_write';
      })
      .map(item => item.capability)
  );
}

export function assertSoundcraftManifestReady(
  manifest: SoundcraftCertificationManifest
): void {
  const untested = manifest.capabilities.filter(
    item => item.status === 'untested'
  );

  if (untested.length > 0) {
    throw new Error(
      `soundcraft_uncertified_capabilities:${untested
        .map(item => item.capability)
        .join(',')}`
    );
  }

  if (!manifest.testedAt || !manifest.firmware) {
    throw new Error('soundcraft_certification_metadata_missing');
  }
}
