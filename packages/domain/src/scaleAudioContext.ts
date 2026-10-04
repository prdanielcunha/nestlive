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
  channelId: EntityId;
  enabled: boolean;
  note?: string;
}

export interface ScaleAudioContext {
  serviceId: EntityId;
  venueId: EntityId;
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
  return context.assignments
    .filter(assignment => assignment.enabled)
    .map(assignment => {
      const role = normalize(assignment.roleName);
      const participant = context.participants.find(
        candidate => normalize(candidate.roleName) === role
      );

      return {
        channelId: assignment.channelId,
        roleName: assignment.roleName,
        participant,
        assignmentId: assignment.id
      };
    });
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
