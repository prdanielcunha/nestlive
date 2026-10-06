import type { CommandResult } from '@millionsnest/nestlive-production-domain';

export interface PreparedBibleRequest {
  reference: string;
  ids: string[];
  verseCount: number;
  providerId?: string;
}

export function bibleRequestFromResults(
  results: CommandResult[],
  fallbackReference: string
): PreparedBibleRequest {
  for (const result of results) {
    if (!result.accepted) continue;
    const rawMatches = result.observedState?.matches;
    const matches = Array.isArray(rawMatches)
      ? rawMatches
      : rawMatches
        ? [rawMatches]
        : [];

    for (const candidate of matches) {
      if (!candidate || typeof candidate !== 'object') continue;
      const match = candidate as Record<string, unknown>;
      const ids = Array.isArray(match.ids)
        ? match.ids.map(String).filter(Boolean)
        : match.id
          ? [String(match.id)]
          : [];
      const verses = Array.isArray(match.verses) ? match.verses : [];
      const reference = String(match.reference || fallbackReference).trim();

      if (reference || ids.length) {
        return {
          reference: reference || fallbackReference,
          ids,
          verseCount: Math.max(ids.length, verses.length),
          providerId: result.providerInstanceId
        };
      }
    }
  }

  return {
    reference: fallbackReference,
    ids: [],
    verseCount: 0
  };
}
