import type { CommandResult } from '@millionsnest/nestlive-production-domain';

export interface PreparedSectionCandidate {
  id: string;
  providerId: string;
  providerName: string;
  index: number;
  label: string;
  excerpt?: string;
  score: number;
}

export interface SectionPresentationContext {
  providerId: string;
  providerName: string;
  presentationId?: string;
  songId?: string;
  title: string;
  currentSlideIndex: number;
  currentSectionId?: string;
  sections: PreparedSectionCandidate[];
}

const STOP_WORDS = new Set([
  'a','ao','aos','as','o','os','de','da','das','do','dos','em','no','na','nos','nas',
  'para','pra','pro','por','voltar','volta','ir','vai','vamos','quero','parte','secao',
  'the','to','go','back','please','section','part','a','an',
  'al','a','la','el','los','las','de','del','por','para','volver','vuelve','seccion','parte'
]);

const SECTION_ALIASES: Record<string, string> = {
  refrao: 'chorus',
  refrain: 'chorus',
  chorus: 'chorus',
  coro: 'chorus',
  estribillo: 'chorus',
  verso: 'verse',
  verse: 'verse',
  estrofe: 'verse',
  ponte: 'bridge',
  bridge: 'bridge',
  intro: 'intro',
  introducao: 'intro',
  introduction: 'intro',
  inicio: 'intro',
  abertura: 'intro',
  final: 'outro',
  fim: 'outro',
  ending: 'outro',
  outro: 'outro',
  interludio: 'interlude',
  interlude: 'interlude',
  instrumental: 'instrumental',
  solo: 'solo',
  tag: 'tag'
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalTokens(value: string): string[] {
  const normalized = normalize(value)
    .replace(/\bpre\s+(refrao|chorus|coro|estribillo)\b/g, 'prechorus')
    .replace(/\bpre[- ]?chorus\b/g, 'prechorus')
    .replace(/\bpre[- ]?refrao\b/g, 'prechorus');

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !STOP_WORDS.has(token))
    .map(token => SECTION_ALIASES[token] || token);
}

function sectionLabel(slide: Record<string, unknown>): string {
  const direct = [
    slide.slide_description,
    slide.label,
    slide.section,
    slide.slide_comment,
    slide.comment
  ]
    .map(value => String(value || '').trim())
    .find(Boolean);

  if (direct) return direct;

  const notes = String(slide.notes || '').trim();
  if (notes && notes.length <= 64 && !notes.includes('\n')) return notes;

  return '';
}

function slideExcerpt(slide: Record<string, unknown>): string | undefined {
  const text = String(slide.text || '').trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length > 88 ? `${text.slice(0, 85)}…` : text;
}

function scoreSection(query: string, label: string): number {
  const queryText = normalize(query);
  const labelText = normalize(label);
  if (!queryText || !labelText) return 0;
  if (queryText === labelText) return 100;
  if (queryText.includes(labelText) || labelText.includes(queryText)) return 80;

  const queryTokens = canonicalTokens(query);
  const labelTokens = canonicalTokens(label);
  if (!queryTokens.length || !labelTokens.length) return 0;

  const labelSet = new Set(labelTokens);
  let score = 0;
  for (const token of queryTokens) {
    if (labelSet.has(token)) score += token.length > 3 ? 24 : 10;
  }

  if (queryTokens[0] && labelTokens[0] === queryTokens[0]) score += 8;
  return score;
}

export function currentPresentationFromResults(
  results: CommandResult[],
  providerId: string
): Record<string, unknown> | null {
  for (const result of results) {
    if (!result.accepted || result.providerInstanceId !== providerId) continue;
    const presentation = result.observedState?.currentPresentation;
    if (presentation && typeof presentation === 'object') {
      return presentation as Record<string, unknown>;
    }
  }
  return null;
}

export function sectionPresentationContext(
  presentation: Record<string, unknown>,
  providerId: string,
  providerName: string
): SectionPresentationContext | null {
  const type = String(presentation.type || presentation.slide_type || '');
  const songId = String(presentation.song_id || '').trim();
  const songLike = Boolean(
    songId ||
    /song|music|lyric|lyrics|música|musica|letra/i.test(type)
  );
  if (!songLike) return null;

  const rawSlides = Array.isArray(presentation.slides) ? presentation.slides : [];
  if (!rawSlides.length) return null;

  const rawSlideNumber = Number(
    presentation.slide_number ??
    presentation.current_slide ??
    presentation.slideIndex
  );
  const currentSlideIndex =
    Number.isFinite(rawSlideNumber) && rawSlideNumber > 0
      ? rawSlideNumber - 1
      : Number.isFinite(rawSlideNumber) && rawSlideNumber >= 0
        ? rawSlideNumber
        : -1;

  const sections: PreparedSectionCandidate[] = [];
  let previousLabel = '';
  rawSlides.forEach((value, index) => {
    if (!value || typeof value !== 'object') return;
    const slide = value as Record<string, unknown>;
    const label = sectionLabel(slide);
    if (!label) return;

    const normalizedLabel = normalize(label);
    if (!normalizedLabel || normalizedLabel === previousLabel) return;
    previousLabel = normalizedLabel;
    sections.push({
      id: `section:${providerId}:${index}`,
      providerId,
      providerName,
      index,
      label,
      excerpt: slideExcerpt(slide),
      score: 0
    });
  });

  if (!sections.length) return null;

  let currentSectionId: string | undefined;
  if (currentSlideIndex >= 0) {
    for (const section of sections) {
      if (section.index <= currentSlideIndex) currentSectionId = section.id;
      else break;
    }
  }

  return {
    providerId,
    providerName,
    presentationId: presentation.id ? String(presentation.id) : undefined,
    songId: songId || undefined,
    title: String(
      presentation.name ||
      presentation.title ||
      presentation.song_title ||
      ''
    ).trim(),
    currentSlideIndex,
    currentSectionId,
    sections
  };
}

export function sectionCandidatesFromResults(
  results: CommandResult[],
  providerId: string,
  providerName: string,
  query: string
): PreparedSectionCandidate[] {
  const presentation = currentPresentationFromResults(results, providerId);
  if (!presentation) return [];

  const rawSlides = Array.isArray(presentation.slides) ? presentation.slides : [];
  const candidates: PreparedSectionCandidate[] = [];
  let previousLabel = '';

  rawSlides.forEach((value, index) => {
    if (!value || typeof value !== 'object') return;
    const slide = value as Record<string, unknown>;
    const label = sectionLabel(slide);
    if (!label) return;

    const normalizedLabel = normalize(label);
    if (!normalizedLabel || normalizedLabel === previousLabel) return;
    previousLabel = normalizedLabel;

    candidates.push({
      id: `section:${providerId}:${index}`,
      providerId,
      providerName,
      index,
      label,
      excerpt: slideExcerpt(slide),
      score: scoreSection(query, label)
    });
  });

  return candidates
    .sort((left, right) =>
      right.score - left.score ||
      left.index - right.index
    )
    .slice(0, 14);
}
