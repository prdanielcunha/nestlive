import type {
  Capability,
  ProviderLink,
  Scene,
  ServicePlan
} from '@millionsnest/nestlive-production-domain';
import type { LiveDropAsset } from '@millionsnest/nestlive-production-domain';

export type UniversalSearchKind =
  | 'song'
  | 'bible'
  | 'media'
  | 'scene'
  | 'text'
  | 'command';

export interface UniversalSearchDocument {
  id: string;
  kind: UniversalSearchKind;
  title: string;
  subtitle?: string;
  aliases?: string[];
  capability?: Capability;
  payload?: Record<string, unknown>;
  targetProviderIds?: string[];
  serviceItemId?: string;
  source: 'prepared-plan' | 'scene' | 'live-drop' | 'recent' | 'command';
  lastUsedAt?: string;
  useCount?: number;
}

export interface UniversalSearchHit extends UniversalSearchDocument {
  score: number;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): string[] {
  return normalize(value).split(' ').filter(Boolean);
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = old;
    }
  }
  return previous[b.length]!;
}

function fuzzyTokenScore(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (candidate === query) return 1;
  if (candidate.startsWith(query)) return 0.96;
  if (candidate.includes(query)) return 0.9;
  const distance = editDistance(query, candidate);
  return Math.max(0, 1 - distance / Math.max(query.length, candidate.length, 1));
}

function relevance(query: string, document: UniversalSearchDocument): number {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 0;

  const fields = [
    document.title,
    document.subtitle || '',
    ...(document.aliases || [])
  ];
  const normalizedFields = fields.map(normalize).filter(Boolean);
  let score = 0;

  for (const field of normalizedFields) {
    if (field === normalizedQuery) score = Math.max(score, 100);
    else if (field.startsWith(normalizedQuery)) score = Math.max(score, 92);
    else if (field.includes(normalizedQuery)) score = Math.max(score, 84);
  }

  const queryTokens = tokens(normalizedQuery);
  const fieldTokens = normalizedFields.flatMap(tokens);
  if (queryTokens.length && fieldTokens.length) {
    const matched = queryTokens.map(queryToken =>
      Math.max(...fieldTokens.map(fieldToken => fuzzyTokenScore(queryToken, fieldToken)))
    );
    const average = matched.reduce((sum, value) => sum + value, 0) / matched.length;
    if (average >= 0.72) score = Math.max(score, Math.round(76 * average));
  }

  if (document.source === 'prepared-plan') score += 8;
  if (document.source === 'recent') score += 3;
  if (document.useCount) score += Math.min(6, Math.log2(document.useCount + 1) * 2);
  if (document.lastUsedAt) {
    const age = Date.now() - Date.parse(document.lastUsedAt);
    if (Number.isFinite(age) && age < 7 * 24 * 60 * 60 * 1000) score += 4;
  }

  return Math.min(120, Math.round(score));
}

function commandDocuments(): UniversalSearchDocument[] {
  return [
    {
      id: 'command:clear',
      kind: 'command',
      title: 'Limpar tela',
      aliases: ['clear', 'limpar', 'blank', 'tela preta'],
      capability: 'presentation.clear',
      payload: {},
      source: 'command'
    },
    {
      id: 'command:next',
      kind: 'command',
      title: 'Próximo slide',
      aliases: ['next', 'avançar', 'proximo', 'próximo'],
      capability: 'presentation.navigation',
      payload: { action: 'next' },
      source: 'command'
    },
    {
      id: 'command:previous',
      kind: 'command',
      title: 'Slide anterior',
      aliases: ['previous', 'voltar', 'anterior'],
      capability: 'presentation.navigation',
      payload: { action: 'previous' },
      source: 'command'
    }
  ];
}

export class UniversalSearchIndex {
  private documents = new Map<string, UniversalSearchDocument>();
  private loaded = false;

  constructor(
    private readonly storageKey: string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null =
      typeof window !== 'undefined' ? window.localStorage : null
  ) {}

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.storage) {
      try {
        const raw = this.storage.getItem(this.storageKey);
        const values = raw ? JSON.parse(raw) as UniversalSearchDocument[] : [];
        for (const value of Array.isArray(values) ? values : []) {
          if (value?.id && value?.title && value?.kind) {
            this.documents.set(value.id, value);
          }
        }
      } catch {
        // Search must remain available even if browser storage is unavailable.
      }
    }
    for (const command of commandDocuments()) this.documents.set(command.id, command);
  }

  seedPrepared(
    plan: ServicePlan | null,
    links: ProviderLink[],
    scenes: Scene[],
    liveDrop: LiveDropAsset[]
  ): void {
    this.load();
    const preserved = [...this.documents.values()].filter(
      item => item.source === 'recent' || item.source === 'command'
    );
    this.documents = new Map(preserved.map(item => [item.id, item]));
    for (const command of commandDocuments()) this.documents.set(command.id, command);

    if (plan) {
      const linksById = new Map(links.map(link => [link.id, link]));
      for (const item of plan.items) {
        if (item.type === 'song') {
          const link = item.providerLinkId ? linksById.get(item.providerLinkId) : undefined;
          this.documents.set(`plan:${item.id}`, {
            id: `plan:${item.id}`,
            kind: 'song',
            title: item.title,
            subtitle: String(item.payload?.artist || ''),
            aliases: [String(item.payload?.key || ''), String(item.payload?.bpm || '')].filter(Boolean),
            capability: 'songs.present',
            payload: link ? { id: link.externalId } : undefined,
            targetProviderIds: link ? [link.providerInstanceId] : undefined,
            serviceItemId: item.id,
            source: 'prepared-plan'
          });
        } else if (item.type === 'bible') {
          this.documents.set(`plan:${item.id}`, {
            id: `plan:${item.id}`,
            kind: 'bible',
            title: item.title,
            capability: 'bible.present',
            payload: item.payload || {},
            serviceItemId: item.id,
            source: 'prepared-plan'
          });
        } else if (['video', 'image', 'audio'].includes(item.type)) {
          this.documents.set(`plan:${item.id}`, {
            id: `plan:${item.id}`,
            kind: 'media',
            title: item.title,
            capability: 'media.open',
            payload: item.payload || {},
            serviceItemId: item.id,
            source: 'prepared-plan'
          });
        } else if (item.type === 'text' || item.type === 'announcement') {
          this.documents.set(`plan:${item.id}`, {
            id: `plan:${item.id}`,
            kind: 'text',
            title: item.title,
            capability: item.type === 'text' ? 'text.present' : 'announcement.present',
            payload: item.payload || {},
            serviceItemId: item.id,
            source: 'prepared-plan'
          });
        }
      }
    }

    for (const scene of scenes) {
      this.documents.set(`scene:${scene.id}`, {
        id: `scene:${scene.id}`,
        kind: 'scene',
        title: scene.name,
        aliases: ['scene', 'cena'],
        source: 'scene'
      });
    }

    for (const asset of liveDrop) {
      if (asset.status !== 'ready') continue;
      this.documents.set(`live-drop:${asset.id}`, {
        id: `live-drop:${asset.id}`,
        kind: 'media',
        title: asset.fileName,
        subtitle: asset.mediaType,
        aliases: ['live drop', asset.mediaType],
        source: 'live-drop'
      });
    }

    this.persist();
  }

  remember(document: UniversalSearchDocument): void {
    this.load();
    const existing = this.documents.get(document.id);
    this.documents.set(document.id, {
      ...existing,
      ...document,
      source: 'recent',
      useCount: (existing?.useCount || 0) + 1,
      lastUsedAt: new Date().toISOString()
    });
    this.persist();
  }

  search(
    query: string,
    kinds?: UniversalSearchKind[],
    limit = 12
  ): UniversalSearchHit[] {
    this.load();
    const allowed = kinds?.length ? new Set(kinds) : null;
    return [...this.documents.values()]
      .filter(document => !allowed || allowed.has(document.kind))
      .map(document => ({ ...document, score: relevance(query, document) }))
      .filter(document => document.score >= 46)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const persisted = [...this.documents.values()]
        .filter(item => item.source !== 'command')
        .sort((a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''))
        .slice(0, 800);
      this.storage.setItem(this.storageKey, JSON.stringify(persisted));
    } catch {
      // Offline search degrades to the current in-memory index.
    }
  }
}
