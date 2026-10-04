import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AudioProfile,
  AudioRouteAlias,
  LiveTemplate,
  LiveTemplateKind
} from '@millionsnest/nestlive-production-domain';

interface WorkspaceFile {
  version: 1;
  audioProfiles: AudioProfile[];
  templates: LiveTemplate[];
}

const EMPTY: WorkspaceFile = {
  version: 1,
  audioProfiles: [],
  templates: []
};

const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const TEMPLATE_KINDS = new Set<LiveTemplateKind>([
  'service-plan',
  'scene-pack',
  'routing',
  'audio-profile',
  'full-production'
]);

function requiredText(value: unknown, code: string, max = 120): string {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new Error(code);
  return text;
}

function id(value: unknown, code: string): string {
  const text = String(value || '').trim();
  if (!ID.test(text)) throw new Error(code);
  return text;
}

function normalizeRoute(value: unknown): AudioRouteAlias {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('audio_route_invalid');
  }
  const item = value as Record<string, unknown>;
  const direction = String(item.direction || '') as AudioRouteAlias['direction'];
  if (!['input', 'output', 'bus', 'aux'].includes(direction)) {
    throw new Error('audio_route_direction_invalid');
  }
  return {
    id: id(item.id, 'audio_route_id_invalid'),
    name: requiredText(item.name, 'audio_route_name_required'),
    providerId: id(item.providerId, 'audio_route_provider_invalid'),
    externalRouteId: requiredText(item.externalRouteId, 'audio_route_external_id_required', 240),
    direction,
    tags: Array.isArray(item.tags)
      ? [...new Set(item.tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 20)
      : undefined
  };
}

function normalizeAudioProfile(value: unknown): AudioProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('audio_profile_invalid');
  }
  const item = value as Record<string, unknown>;
  const routes = Array.isArray(item.routes) ? item.routes.map(normalizeRoute) : [];
  if (routes.length > 256 || new Set(routes.map(route => route.id)).size !== routes.length) {
    throw new Error('audio_profile_routes_invalid');
  }
  const now = new Date().toISOString();
  return {
    id: id(item.id, 'audio_profile_id_invalid'),
    organizationId: id(item.organizationId, 'audio_profile_org_invalid'),
    venueId: id(item.venueId, 'audio_profile_venue_invalid'),
    liveSystemId: id(item.liveSystemId, 'audio_profile_system_invalid'),
    name: requiredText(item.name, 'audio_profile_name_required'),
    routes,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: now
  };
}

function normalizeTemplate(value: unknown): LiveTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('live_template_invalid');
  }
  const item = value as Record<string, unknown>;
  const kind = String(item.kind || '') as LiveTemplateKind;
  if (!TEMPLATE_KINDS.has(kind)) throw new Error('live_template_kind_invalid');

  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown>
      : {};
  if (JSON.stringify(payload).length > 512_000) {
    throw new Error('live_template_payload_too_large');
  }

  const marketplaceStatus = String(item.marketplaceStatus || 'private');
  if (!['private', 'review'].includes(marketplaceStatus)) {
    throw new Error('live_template_marketplace_status_requires_review');
  }

  const now = new Date().toISOString();
  return {
    id: id(item.id, 'live_template_id_invalid'),
    organizationId: id(item.organizationId, 'live_template_org_invalid'),
    name: requiredText(item.name, 'live_template_name_required'),
    description:
      item.description == null
        ? undefined
        : requiredText(item.description, 'live_template_description_invalid', 500),
    kind,
    version:
      Number.isInteger(Number(item.version)) && Number(item.version) > 0
        ? Number(item.version)
        : 1,
    payload,
    shared: item.shared === true,
    marketplaceStatus: marketplaceStatus as 'private' | 'review',
    createdBy: id(item.createdBy, 'live_template_creator_invalid'),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : now,
    updatedAt: now
  };
}

export class ProductionWorkspaceStore {
  private loaded = false;
  private file: WorkspaceFile = structuredClone(EMPTY);
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as WorkspaceFile;
      this.file = raw.version === 1
        ? {
            version: 1,
            audioProfiles: Array.isArray(raw.audioProfiles) ? raw.audioProfiles : [],
            templates: Array.isArray(raw.templates) ? raw.templates : []
          }
        : structuredClone(EMPTY);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.file = structuredClone(EMPTY);
    }
    this.loaded = true;
  }

  async audioProfiles(scope: {
    organizationId: string;
    venueId: string;
    liveSystemId: string;
  }): Promise<AudioProfile[]> {
    await this.load();
    return structuredClone(this.file.audioProfiles.filter(profile =>
      profile.organizationId === scope.organizationId &&
      profile.venueId === scope.venueId &&
      profile.liveSystemId === scope.liveSystemId
    ));
  }

  async upsertAudioProfile(
    input: unknown,
    scope: {
      organizationId: string;
      venueId: string;
      liveSystemId: string;
    }
  ): Promise<AudioProfile> {
    await this.load();
    const profile = normalizeAudioProfile(input);
    if (
      profile.organizationId !== scope.organizationId ||
      profile.venueId !== scope.venueId ||
      profile.liveSystemId !== scope.liveSystemId
    ) {
      throw new Error('audio_profile_scope_forbidden');
    }

    const existing = this.file.audioProfiles.find(item => item.id === profile.id);
    if (existing && existing.organizationId !== scope.organizationId) {
      throw new Error('audio_profile_scope_forbidden');
    }
    profile.createdAt = existing?.createdAt || profile.createdAt;

    await this.mutate(() => {
      this.file.audioProfiles = this.file.audioProfiles.filter(item => item.id !== profile.id);
      this.file.audioProfiles.push(profile);
    });
    return structuredClone(profile);
  }

  async templates(organizationId: string): Promise<LiveTemplate[]> {
    await this.load();
    return structuredClone(
      this.file.templates.filter(template => template.organizationId === organizationId)
    );
  }

  async upsertTemplate(
    input: unknown,
    organizationId: string,
    actorId: string
  ): Promise<LiveTemplate> {
    await this.load();
    const candidate =
      input && typeof input === 'object' && !Array.isArray(input)
        ? { ...(input as Record<string, unknown>), organizationId, createdBy: actorId }
        : input;
    const template = normalizeTemplate(candidate);
    const existing = this.file.templates.find(item => item.id === template.id);
    if (existing && existing.organizationId !== organizationId) {
      throw new Error('live_template_scope_forbidden');
    }
    template.createdAt = existing?.createdAt || template.createdAt;
    template.version = existing ? existing.version + 1 : template.version;

    await this.mutate(() => {
      this.file.templates = this.file.templates.filter(item => item.id !== template.id);
      this.file.templates.push(template);
    });
    return structuredClone(template);
  }

  async decideMarketplace(input: {
    organizationId: string;
    templateId: string;
    decision: 'approved' | 'rejected';
    reviewerId: string;
  }): Promise<LiveTemplate> {
    await this.load();
    const template = this.file.templates.find(item =>
      item.id === input.templateId &&
      item.organizationId === input.organizationId
    );
    if (!template) throw new Error('live_template_not_found');
    if (template.marketplaceStatus !== 'review') {
      throw new Error('live_template_not_in_review');
    }
    if (!ID.test(input.reviewerId)) throw new Error('live_template_reviewer_invalid');

    const updated: LiveTemplate = {
      ...template,
      marketplaceStatus: input.decision,
      shared: input.decision === 'approved',
      updatedAt: new Date().toISOString(),
      payload: {
        ...template.payload,
        marketplaceReview: {
          reviewerId: input.reviewerId,
          decidedAt: new Date().toISOString(),
          decision: input.decision
        }
      }
    };

    await this.mutate(() => {
      this.file.templates = this.file.templates.map(item =>
        item.id === updated.id ? updated : item
      );
    });
    return structuredClone(updated);
  }

  async replaceFromBackup(input: {
    audioProfiles: AudioProfile[];
    templates: LiveTemplate[];
    organizationId: string;
    venueId: string;
    liveSystemId: string;
  }): Promise<void> {
    await this.load();
    const profiles = input.audioProfiles.map(normalizeAudioProfile);
    if (profiles.some(profile =>
      profile.organizationId !== input.organizationId ||
      profile.venueId !== input.venueId ||
      profile.liveSystemId !== input.liveSystemId
    )) {
      throw new Error('backup_audio_profile_scope_forbidden');
    }

    const templates = input.templates.map(template => {
      const normalized = {
        ...template,
        marketplaceStatus:
          template.marketplaceStatus === 'approved' || template.marketplaceStatus === 'rejected'
            ? 'review'
            : template.marketplaceStatus,
        shared: false
      };
      return normalizeTemplate(normalized);
    });
    if (templates.some(template => template.organizationId !== input.organizationId)) {
      throw new Error('backup_template_scope_forbidden');
    }

    await this.mutate(() => {
      this.file.audioProfiles = this.file.audioProfiles
        .filter(profile =>
          profile.organizationId !== input.organizationId ||
          profile.venueId !== input.venueId ||
          profile.liveSystemId !== input.liveSystemId
        )
        .concat(profiles);
      this.file.templates = this.file.templates
        .filter(template => template.organizationId !== input.organizationId)
        .concat(templates);
    });
  }

  private async mutate(change: () => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      change();
      await this.persist();
    });
    await this.queue;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
