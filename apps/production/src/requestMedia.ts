import type { CommandResult, LiveDropAsset } from '@millionsnest/nestlive-production-domain';

export type RequestMediaKind = 'video' | 'image' | 'audio';

export interface PreparedRequestMediaCandidate {
  id: string;
  source: 'provider' | 'live-drop';
  kind: RequestMediaKind;
  name: string;
  providerId?: string;
  providerName?: string;
  assetId?: string;
  thumbnail?: string;
  metadata?: string;
}

export function requestMediaThumbnailUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (normalized.startsWith('data:image/')) return normalized;
  const mime = normalized.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${normalized}`;
}

export function normalizeRequestMediaResults(
  results: CommandResult[],
  providerId: string,
  providerName: string,
  kind: RequestMediaKind
): PreparedRequestMediaCandidate[] {
  const seen = new Set<string>();

  return results
    .filter(result => result.providerInstanceId === providerId && result.accepted)
    .flatMap(result => {
      const value = result.observedState?.results;
      return Array.isArray(value) ? value : [];
    })
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      const name = String(item.name || item.file || '').trim();
      const thumbnail = typeof item.thumbnail === 'string'
        ? requestMediaThumbnailUrl(item.thumbnail)
        : undefined;
      const dimensions =
        typeof item.width === 'number' && typeof item.height === 'number'
          ? `${item.width}×${item.height}`
          : undefined;
      const duration =
        typeof item.duration_ms === 'number'
          ? `${Math.max(1, Math.round(item.duration_ms / 1000))}s`
          : undefined;

      return {
        id: `provider:${providerId}:${kind}:${name}`,
        source: 'provider' as const,
        kind,
        name,
        providerId,
        providerName,
        thumbnail,
        metadata: dimensions || duration
      };
    })
    .filter(item => item.name && !seen.has(item.id) && seen.add(item.id))
    .slice(0, 12);
}

export function liveDropRequestMediaCandidates(
  assets: LiveDropAsset[],
  query: string
): PreparedRequestMediaCandidate[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return assets
    .filter(asset => asset.status === 'ready')
    .filter(asset =>
      asset.mediaType === 'video' ||
      asset.mediaType === 'image' ||
      asset.mediaType === 'audio'
    )
    .filter(asset =>
      !normalizedQuery ||
      asset.fileName.toLocaleLowerCase().includes(normalizedQuery)
    )
    .map(asset => ({
      id: `live-drop:${asset.id}`,
      source: 'live-drop' as const,
      kind: asset.mediaType as RequestMediaKind,
      name: asset.fileName,
      assetId: asset.id,
      providerName: 'Live Drop',
      metadata: 'cache local'
    }))
    .slice(0, 8);
}
