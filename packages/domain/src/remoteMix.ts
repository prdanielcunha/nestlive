import type { EntityId } from './audio';

export type RemoteMeterProfile =
  | 'lan_full'
  | 'remote_high'
  | 'remote_medium'
  | 'remote_low'
  | 'off';

export interface RemoteMixGrant {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  actorId: EntityId;
  role: 'technical_admin' | 'operator' | 'viewer';
  permissions: Array<
    | 'audio.read'
    | 'audio.fader.write'
    | 'audio.mute.write'
    | 'audio.guarded.write'
    | 'audio.critical.write'
  >;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface RemoteLinkQuality {
  local: boolean;
  rttMs?: number;
  packetLossPercent?: number;
  visible: boolean;
}

export function selectRemoteMeterProfile(
  quality: RemoteLinkQuality
): RemoteMeterProfile {
  if (!quality.visible) return 'off';
  if (quality.local) return 'lan_full';

  const rtt = quality.rttMs ?? 9999;
  const loss = quality.packetLossPercent ?? 100;

  if (loss > 8 || rtt > 500) return 'remote_low';
  if (loss > 3 || rtt > 250) return 'remote_medium';
  return 'remote_high';
}

export function meterProfileTargetFps(
  profile: RemoteMeterProfile
): number {
  switch (profile) {
    case 'lan_full':
      return 30;
    case 'remote_high':
      return 15;
    case 'remote_medium':
      return 8;
    case 'remote_low':
      return 3;
    case 'off':
      return 0;
  }
}

export function canUseRemoteCapability(
  grant: RemoteMixGrant,
  capability: string,
  now = new Date()
): boolean {
  if (grant.revokedAt) return false;
  if (new Date(grant.expiresAt).getTime() <= now.getTime()) return false;

  if (capability.endsWith('.read')) {
    return grant.permissions.includes('audio.read');
  }
  if (capability === 'audio.fader.write') {
    return grant.permissions.includes('audio.fader.write');
  }
  if (capability === 'audio.mute.write') {
    return grant.permissions.includes('audio.mute.write');
  }
  if (
    capability === 'audio.gain.write' ||
    capability === 'audio.eq.write' ||
    capability === 'audio.gate.write' ||
    capability === 'audio.compressor.write'
  ) {
    return grant.permissions.includes('audio.guarded.write');
  }
  if (
    capability === 'audio.phantom.write' ||
    capability === 'audio.scene.recall'
  ) {
    return grant.permissions.includes('audio.critical.write');
  }

  return false;
}
