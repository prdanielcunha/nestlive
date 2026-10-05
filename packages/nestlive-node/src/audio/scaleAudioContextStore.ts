import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioRoleChannelAssignment,
  ScaleAudioContext
} from '@millionsnest/nestlive-domain';
import type { AccessTokenBinding } from '../security/accessTokenStore';

interface PersistedScaleAudioContext {
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  context: Omit<ScaleAudioContext, 'assignments'>;
  updatedAt: string;
}

interface ScaleAudioContextFile {
  version: 1;
  current?: PersistedScaleAudioContext;
  assignments: AudioRoleChannelAssignment[];
}

function clean(value: string, field: string): string {
  const next = String(value ?? '').trim();
  if (!next || next.length > 256 || /[\u0000-\u001f\u007f]/.test(next)) {
    throw new Error(`scale_audio_${field}_invalid`);
  }
  return next;
}

function assignmentKey(input: {
  participantUserId?: string;
  roleName: string;
}): string {
  return input.participantUserId?.trim()
    ? `person:${input.participantUserId.trim()}`
    : `role:${input.roleName.trim().toLowerCase()}`;
}

export class ScaleAudioContextStore {
  constructor(private readonly filePath: string) {}

  async current(): Promise<ScaleAudioContext | undefined> {
    const file = await this.read();
    if (!file.current) return undefined;
    const assignments = file.assignments.filter(
      item => item.venueId === file.current?.venueId && item.enabled
    );
    return {
      ...file.current.context,
      organizationId: file.current.organizationId,
      venueId: file.current.venueId,
      liveSystemId: file.current.liveSystemId,
      assignments
    };
  }

  async saveContext(
    binding: AccessTokenBinding,
    input: Omit<ScaleAudioContext, 'assignments' | 'venueId'> & {
      venueId?: string;
    },
    now = new Date()
  ): Promise<ScaleAudioContext> {
    const serviceId = clean(input.serviceId, 'service_id');
    const title = clean(input.title, 'title');
    if (input.venueId && input.venueId !== binding.venueId) {
      throw new Error('scale_audio_scope_mismatch');
    }
    if (
      input.organizationId &&
      input.organizationId !== binding.organizationId
    ) {
      throw new Error('scale_audio_scope_mismatch');
    }
    if (
      input.liveSystemId &&
      input.liveSystemId !== binding.liveSystemId
    ) {
      throw new Error('scale_audio_scope_mismatch');
    }

    const participants = (input.participants ?? []).map(participant => ({
      userId: clean(participant.userId, 'participant_user_id'),
      displayName: clean(participant.displayName, 'participant_name'),
      roleName: clean(participant.roleName, 'participant_role')
    }));

    const file = await this.read();
    file.current = {
      organizationId: binding.organizationId,
      venueId: binding.venueId,
      liveSystemId: binding.liveSystemId,
      context: {
        serviceId,
        organizationId: binding.organizationId,
        venueId: binding.venueId,
        liveSystemId: binding.liveSystemId,
        title,
        scheduledAt: clean(input.scheduledAt, 'scheduled_at'),
        participants
      },
      updatedAt: now.toISOString()
    };
    await this.write(file);
    return (await this.current())!;
  }

  async upsertAssignment(input: {
    roleName: string;
    participantUserId?: string;
    channelId: string;
    enabled?: boolean;
  }): Promise<AudioRoleChannelAssignment> {
    const file = await this.read();
    if (!file.current) throw new Error('scale_audio_context_missing');

    const roleName = clean(input.roleName, 'assignment_role');
    const participantUserId =
      input.participantUserId?.trim() || undefined;
    const channelId = clean(input.channelId, 'assignment_channel');
    if (!/^ch-\d{2}$/.test(channelId)) {
      throw new Error('scale_audio_channel_id_invalid');
    }

    const key = assignmentKey({ participantUserId, roleName });
    const existing = file.assignments.find(
      item =>
        item.venueId === file.current?.venueId &&
        assignmentKey(item) === key
    );

    const assignment: AudioRoleChannelAssignment = {
      id: existing?.id ?? randomUUID(),
      venueId: file.current.venueId,
      roleName,
      participantUserId,
      channelId,
      enabled: input.enabled !== false
    };

    file.assignments = [
      ...file.assignments.filter(item => item.id !== assignment.id),
      assignment
    ];
    await this.write(file);
    return assignment;
  }

  async clearCurrent(): Promise<void> {
    const file = await this.read();
    delete file.current;
    await this.write(file);
  }

  private async read(): Promise<ScaleAudioContextFile> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ScaleAudioContextFile;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.assignments)
      ) {
        throw new Error('scale_audio_store_invalid');
      }
      return parsed;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { version: 1, assignments: [] };
      }
      throw error;
    }
  }

  private async write(value: ScaleAudioContextFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temp, this.filePath);
  }
}
