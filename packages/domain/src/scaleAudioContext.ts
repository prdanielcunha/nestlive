import type { EntityId } from './audio';
import type { SoundcheckSession } from './soundcheck';

export interface ScaleParticipant {
  userId: EntityId;
  displayName: string;
  roleName: string;
}

export interface AudioRoleChannelAssignment {
  id: EntityId;
  venueId: EntityId;
  roleName: string;
  participantUserId?: EntityId;
  channelId: EntityId;
  enabled: boolean;
  note?: string;
}

export interface ScaleAudioContext {
  serviceId: EntityId;
  organizationId?: EntityId;
  venueId: EntityId;
  liveSystemId?: EntityId;
  title: string;
  scheduledAt: string;
  participants: ScaleParticipant[];
  assignments: AudioRoleChannelAssignment[];
}

export interface ResolvedScaleChannel {
  channelId: EntityId;
  roleName: string;
  participant?: ScaleParticipant;
  assignmentId: EntityId;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function resolveScaleChannels(
  context: ScaleAudioContext
): ResolvedScaleChannel[] {
  const enabled = context.assignments.filter(
    assignment => assignment.enabled
  );
  const resolved: ResolvedScaleChannel[] = [];
  const consumed = new Set<string>();

  for (const participant of context.participants) {
    const participantSpecific = enabled.find(
      assignment =>
        assignment.participantUserId === participant.userId
    );
    const byRole = enabled.find(
      assignment =>
        !assignment.participantUserId &&
        normalize(assignment.roleName) ===
          normalize(participant.roleName)
    );
    const assignment = participantSpecific ?? byRole;
    if (!assignment) continue;

    consumed.add(assignment.id);
    resolved.push({
      channelId: assignment.channelId,
      roleName: assignment.roleName,
      participant,
      assignmentId: assignment.id
    });
  }

  for (const assignment of enabled) {
    if (consumed.has(assignment.id)) continue;
    resolved.push({
      channelId: assignment.channelId,
      roleName: assignment.roleName,
      assignmentId: assignment.id
    });
  }

  return resolved;
}

export function buildSoundcheckFromScale(
  context: ScaleAudioContext,
  now = new Date()
): SoundcheckSession {
  return {
    id: `soundcheck:${context.serviceId}`,
    serviceId: context.serviceId,
    title: context.title,
    startedAt: now.toISOString(),
    channels: resolveScaleChannels(context).map(item => ({
      channelId: item.channelId,
      roleName: item.roleName,
      musicianName: item.participant?.displayName,
      state: 'pending',
      clipCount: 0
    }))
  };
}

/**
 * Deliberately returns descriptive context only.
 * A changed person in the scale never mutates gain, routing or console state.
 */
export function scaleAudioLabel(
  resolved: ResolvedScaleChannel
): string {
  return resolved.participant
    ? `${resolved.roleName} · ${resolved.participant.displayName}`
    : resolved.roleName;
}
