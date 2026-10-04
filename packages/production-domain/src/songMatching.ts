export interface SongIdentity {
  id: string;
  title: string;
  artist?: string;
  version?: string;
  lyricsFingerprint?: string;
  historyWeight?: number;
}

export interface SongMatchCandidate extends SongIdentity {
  score: number;
  confidence: 'high' | 'medium' | 'low';
  titleExact: boolean;
  artistExact: boolean;
  reasons: string[];
}

export type SongMatchDecision =
  | { status: 'matched'; candidate: SongMatchCandidate }
  | { status: 'ambiguous'; candidates: SongMatchCandidate[] }
  | { status: 'missing'; candidates: SongMatchCandidate[] };

export function normalizeSongIdentity(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|part|participacao|participação)\.?\b.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: string): Set<string> {
  return new Set(
    normalizeSongIdentity(value)
      .split(' ')
      .filter(part => part.length >= 2)
  );
}

function tokenSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / new Set([...left, ...right]).size;
}

function normalizedFingerprint(value?: string): string {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function confidence(score: number): SongMatchCandidate['confidence'] {
  if (score >= 90) return 'high';
  if (score >= 76) return 'medium';
  return 'low';
}

function candidateFor(
  source: Omit<SongIdentity, 'id'>,
  song: SongIdentity
): SongMatchCandidate {
  const sourceTitle = normalizeSongIdentity(source.title);
  const sourceArtist = normalizeSongIdentity(source.artist || '');
  const sourceVersion = normalizeSongIdentity(source.version || '');
  const candidateTitle = normalizeSongIdentity(song.title);
  const candidateArtist = normalizeSongIdentity(song.artist || '');
  const candidateVersion = normalizeSongIdentity(song.version || '');
  const titleExact = Boolean(sourceTitle) && candidateTitle === sourceTitle;
  const artistExact = Boolean(sourceArtist) && candidateArtist === sourceArtist;
  const titleSimilarity = tokenSimilarity(source.title, song.title);
  const artistSimilarity = sourceArtist && candidateArtist
    ? tokenSimilarity(source.artist || '', song.artist || '')
    : 0;
  const reasons: string[] = [];
  let score = 0;

  if (titleExact) {
    score += 72;
    reasons.push('title_exact');
  } else if (titleSimilarity >= 0.85) {
    score += Math.round(58 * titleSimilarity);
    reasons.push('title_close');
  } else if (titleSimilarity >= 0.65) {
    // A close-but-incomplete title should remain visible for human review.
    // Keep the score below auto-match territory while allowing corroborating
    // artist evidence to lift the candidate above the review threshold.
    score += Math.round(54 * titleSimilarity);
    reasons.push('title_partial');
  }

  if (sourceArtist) {
    if (artistExact) {
      score += 18;
      reasons.push('artist_exact');
    } else if (artistSimilarity >= 0.7) {
      score += Math.round(11 * artistSimilarity);
      reasons.push('artist_close');
    }
  } else if (titleExact) {
    score += 7;
    reasons.push('artist_not_required');
  }

  if (sourceVersion && candidateVersion) {
    if (sourceVersion === candidateVersion) {
      score += 8;
      reasons.push('version_exact');
    } else {
      score -= 8;
      reasons.push('version_differs');
    }
  }

  const sourceFingerprint = normalizedFingerprint(source.lyricsFingerprint);
  const candidateFingerprint = normalizedFingerprint(song.lyricsFingerprint);
  if (sourceFingerprint && candidateFingerprint) {
    if (sourceFingerprint === candidateFingerprint) {
      score += 22;
      reasons.push('lyrics_fingerprint_exact');
    } else {
      score -= 14;
      reasons.push('lyrics_fingerprint_differs');
    }
  }

  if (typeof song.historyWeight === 'number' && Number.isFinite(song.historyWeight)) {
    const historyBoost = Math.max(0, Math.min(10, song.historyWeight));
    if (historyBoost > 0) {
      score += historyBoost;
      reasons.push('previously_confirmed');
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    ...song,
    score,
    confidence: confidence(score),
    titleExact,
    artistExact,
    reasons
  };
}

export function matchExternalSong(
  source: Omit<SongIdentity, 'id'>,
  externalSongs: SongIdentity[]
): SongMatchDecision {
  const candidates = externalSongs
    .map(song => candidateFor(source, song))
    .filter(candidate => candidate.score >= 58)
    .sort((a, b) =>
      b.score - a.score ||
      Number(b.titleExact) - Number(a.titleExact) ||
      a.title.localeCompare(b.title)
    );

  if (!candidates.length) {
    return { status: 'missing', candidates: [] };
  }

  const [best, second] = candidates;
  const margin = best!.score - (second?.score || 0);

  // Auto-match only when evidence is strong and clearly separated.
  // This intentionally refuses "pretty close" guesses before Live.
  if (
    best!.score >= 90 &&
    (candidates.length === 1 || margin >= 12)
  ) {
    return { status: 'matched', candidate: best! };
  }

  return {
    status: 'ambiguous',
    candidates: candidates.slice(0, 8)
  };
}
