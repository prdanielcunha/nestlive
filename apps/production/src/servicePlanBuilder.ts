import type {
  ProviderLink,
  ServiceItem,
  ServicePlan
} from '@millionsnest/nestlive-production-domain';
import type { SharedScale } from './musicScaleBridge';

export interface PreparedSongLink {
  musicScaleSongId: string;
  providerInstanceId: string;
  externalId: string;
  fingerprint?: string;
}

export function buildServicePlan(
  scale: SharedScale,
  scope: {
    venueId: string;
    liveSystemId: string;
  },
  links: PreparedSongLink[] = []
): { plan: ServicePlan; providerLinks: ProviderLink[] } {
  const linksBySong = new Map(links.map(link => [link.musicScaleSongId, link]));
  const providerLinks: ProviderLink[] = links.map(link => ({
    id: `provider-link:${link.providerInstanceId}:${link.musicScaleSongId}`,
    organizationId: scale.organizationId,
    venueId: scope.venueId,
    providerInstanceId: link.providerInstanceId,
    entityType: 'song',
    musicScaleEntityId: link.musicScaleSongId,
    externalId: link.externalId,
    fingerprint: link.fingerprint,
    lastVerifiedAt: new Date().toISOString()
  }));

  const providerLinkIdBySong = new Map(
    providerLinks.map(link => [link.musicScaleEntityId || '', link.id])
  );

  const items: ServiceItem[] = scale.songs.map((song, index) => {
    const link = linksBySong.get(song.id);
    return {
      id: `song:${song.id}`,
      type: 'song',
      title: song.title,
      sourceEntityId: song.id,
      providerLinkId: providerLinkIdBySong.get(song.id),
      state: link ? 'prepared' : 'planned',
      payload: {
        order: index + 1,
        artist: song.artist || null,
        key: song.selectedKey || song.key || null,
        bpm: song.selectedBpm ?? song.bpm ?? null
      }
    };
  });

  const clock = scale.time?.trim() || '00:00';
  const scheduledAt = `${scale.date}T${/^\d{1,2}:\d{2}:\d{2}$/.test(clock) ? clock : `${clock}:00`}`;

  const plan: ServicePlan = {
    id: `music-scale:${scale.id}`,
    organizationId: scale.organizationId,
    venueId: scope.venueId,
    liveSystemId: scope.liveSystemId,
    sourceMusicScaleId: scale.id,
    title: scale.eventName || 'Culto',
    scheduledAt,
    metadata: {
      organizationName: scale.organizationName || null,
      locationName: scale.locationName || null,
      timeZone: scale.timeZone || null
    },
    items,
    revision: Math.max(1, scale.publishRevision || 1)
  };

  return { plan, providerLinks };
}
