import { useEffect, useRef } from 'react';
import { matchExternalSong, type ServicePlan, type SongIdentity } from '@millionsnest/nestlive-production-domain';
import type { SharedScale } from './musicScaleBridge';
import { buildServicePlan, type PreparedSongLink } from './servicePlanBuilder';
import { liveFeatureFlags } from './featureFlags';
import { syncPreparedServicePlan } from './liveCloudRepository';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

interface ExternalSong extends SongIdentity {
  key?: string;
  bpm?: number;
}

interface PlaylistSnapshot {
  scaleId: string;
  revision: number;
  ids: string[];
  titles: Map<string, string>;
}

interface PlaylistDelta {
  added: string[];
  removed: string[];
  moved: string[];
}

function snapshotFromScale(scale: SharedScale): PlaylistSnapshot {
  return {
    scaleId: scale.id,
    revision: Math.max(1, scale.publishRevision || 1),
    ids: [...scale.songIds],
    titles: new Map(scale.songs.map(song => [song.id, song.title]))
  };
}

function snapshotFromCachedPlan(
  scale: SharedScale,
  plan: ServicePlan | null | undefined
): PlaylistSnapshot | null {
  if (!plan || plan.sourceMusicScaleId !== scale.id || !Array.isArray(plan.items)) return null;
  const songItems = plan.items.filter(item => item.type === 'song' && item.sourceEntityId);
  if (!songItems.length) return null;
  return {
    scaleId: scale.id,
    revision: Math.max(1, Number(plan.revision) || 1),
    ids: songItems.map(item => String(item.sourceEntityId)),
    titles: new Map(songItems.map(item => [String(item.sourceEntityId), String(item.title || 'Música')]))
  };
}

function snapshotSignature(snapshot: PlaylistSnapshot): string {
  return `${snapshot.scaleId}:${snapshot.ids.join('|')}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function diffPlaylist(previous: PlaylistSnapshot, current: PlaylistSnapshot): PlaylistDelta {
  const previousSet = new Set(previous.ids);
  const currentSet = new Set(current.ids);
  const addedIds = current.ids.filter(id => !previousSet.has(id));
  const removedIds = previous.ids.filter(id => !currentSet.has(id));

  const previousCommon = previous.ids.filter(id => currentSet.has(id));
  const currentCommon = current.ids.filter(id => previousSet.has(id));
  const previousCommonIndex = new Map(previousCommon.map((id, index) => [id, index]));
  const movedIds = previousCommon.length === currentCommon.length &&
    previousCommon.some((id, index) => currentCommon[index] !== id)
      ? currentCommon.filter((id, index) => previousCommonIndex.get(id) !== index)
      : [];

  return {
    added: addedIds.map(id => current.titles.get(id) || id),
    removed: removedIds.map(id => previous.titles.get(id) || id),
    moved: movedIds.map(id => current.titles.get(id) || previous.titles.get(id) || id)
  };
}

function extractExternalSongs(
  results: Awaited<ReturnType<Controller['executeCommand']>>
): ExternalSong[] {
  return results
    .flatMap(result => {
      const value = result.observedState?.results;
      return Array.isArray(value) ? value : [];
    })
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      return {
        id: String(item.id || ''),
        title: String(item.title || ''),
        artist: item.artist ? String(item.artist) : undefined,
        key: item.key ? String(item.key) : undefined,
        bpm: typeof item.bpm === 'number' ? item.bpm : undefined
      };
    })
    .filter(item => item.id && item.title);
}

export function PlaylistSyncAutomation({
  controller,
  scale,
  actorId
}: {
  controller: Controller;
  scale: SharedScale;
  actorId: string;
}) {
  const memorySnapshot = useRef<PlaylistSnapshot | null>(null);
  const inFlightSignature = useRef<string | null>(null);
  const executeCommand = controller.executeCommand;
  const cacheServicePlan = controller.cacheServicePlan;
  const submitRequest = controller.submitRequest;

  useEffect(() => {
    if (!controller.credential || controller.state !== 'connected') return;

    const current = snapshotFromScale(scale);
    const currentSignature = snapshotSignature(current);
    const cached = snapshotFromCachedPlan(scale, controller.nodeState?.state.servicePlan);

    let previous: PlaylistSnapshot | null = null;
    if (cached && snapshotSignature(cached) !== currentSignature) {
      previous = cached;
    } else if (
      memorySnapshot.current &&
      memorySnapshot.current.scaleId === scale.id &&
      snapshotSignature(memorySnapshot.current) !== currentSignature
    ) {
      previous = memorySnapshot.current;
    }

    if (!previous) {
      memorySnapshot.current = current;
      return;
    }

    if (inFlightSignature.current === currentSignature) return;

    const candidates = (controller.nodeState?.providers || []).filter(candidate =>
      (candidate.health === 'online' || candidate.health === 'degraded') &&
      candidate.capabilities.includes('songs.search') &&
      candidate.capabilities.includes('playlist.sync')
    );
    const routedProviderId = controller.nodeState?.routing?.songs;
    const provider = routedProviderId
      ? candidates.find(candidate => candidate.providerId === routedProviderId) || null
      : candidates.length === 1
        ? candidates[0]!
        : null;

    if (!provider) return;

    const delta = diffPlaylist(previous, current);
    const changeId = stableHash(`${snapshotSignature(previous)}->${currentSignature}`);
    inFlightSignature.current = currentSignature;

    const publishNotice = async (
      syncStatus: 'synced' | 'needs_attention' | 'failed',
      unresolved: string[] = [],
      errorCode?: string
    ) => {
      await submitRequest({
        id: `playlist-sync:${scale.id}:${changeId}:${syncStatus}`,
        liveSessionId: `music-scale:${scale.id}`,
        actorId: 'system:playlist-sync',
        kind: 'message',
        payload: {
          source: 'playlist-sync',
          syncStatus,
          providerName: provider.displayName || provider.providerKey || 'provider',
          added: delta.added,
          removed: delta.removed,
          moved: delta.moved,
          unresolved,
          revision: current.revision,
          errorCode: errorCode || null
        }
      });
    };

    void (async () => {
      try {
        const prepared: PreparedSongLink[] = [];
        const unresolved: string[] = [];

        for (const source of scale.songs) {
          const results = await executeCommand({
            capability: 'songs.search',
            payload: {
              text: source.title,
              title: true,
              artist: true,
              fields: 'id,title,artist,key,bpm'
            },
            liveSessionId: `preflight:${scale.id}`,
            actorId,
            targetProviderIds: [provider.providerId]
          });
          const externalSongs = extractExternalSongs(results);
          const decision = matchExternalSong(
            { title: source.title, artist: source.artist },
            externalSongs
          );

          if (decision.status !== 'matched') {
            unresolved.push(source.title);
            continue;
          }

          prepared.push({
            musicScaleSongId: source.id,
            providerInstanceId: provider.providerId,
            externalId: decision.candidate.id,
            fingerprint: `${decision.candidate.title}|${decision.candidate.artist || ''}`
          });
        }

        if (unresolved.length > 0) {
          await publishNotice('needs_attention', unresolved);
          return;
        }

        const ids = prepared.map(link => link.externalId);
        const results = await executeCommand({
          capability: 'playlist.sync',
          payload: { ids },
          liveSessionId: `music-scale:${scale.id}`,
          actorId,
          targetProviderIds: [provider.providerId],
          safetyLevel: 'guarded',
          confirmed: true
        });
        const failed = results.find(result => !result.accepted);
        if (failed) {
          await publishNotice('failed', [], failed.errorCode || 'provider_error');
          return;
        }

        if (!controller.credential) return;
        const { plan, providerLinks } = buildServicePlan(
          scale,
          {
            venueId: controller.credential.binding.venueId,
            liveSystemId: controller.credential.binding.liveSystemId
          },
          prepared
        );
        await cacheServicePlan(plan, providerLinks);
        if (liveFeatureFlags.servicePlanWrites) {
          await syncPreparedServicePlan(plan, providerLinks, actorId).catch(() => undefined);
        }
        await publishNotice('synced');
      } catch (error) {
        await publishNotice(
          'failed',
          [],
          error instanceof Error ? error.message : 'playlist_sync_failed'
        ).catch(() => undefined);
      } finally {
        memorySnapshot.current = current;
        inFlightSignature.current = null;
      }
    })();
  }, [
    actorId,
    cacheServicePlan,
    controller.credential,
    controller.nodeState,
    controller.state,
    executeCommand,
    scale,
    submitRequest
  ]);

  return null;
}
