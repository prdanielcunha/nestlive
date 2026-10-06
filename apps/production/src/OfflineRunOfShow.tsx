import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  matchExternalSong,
  type ProviderLink,
  type ServicePlan
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

interface ExternalSong {
  id: string;
  title: string;
  artist?: string;
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
        artist: item.artist ? String(item.artist) : undefined
      };
    })
    .filter(item => item.id && item.title);
}

export function OfflineRunOfShow({
  controller,
  plan,
  providerLinks,
  actorId,
  liveSessionId
}: {
  controller: Controller;
  plan: ServicePlan;
  providerLinks: ProviderLink[];
  actorId: string;
  liveSessionId?: string;
}) {
  const { t } = useTranslation();
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const linksById = useMemo(
    () => new Map(providerLinks.map(link => [link.id, link])),
    [providerLinks]
  );
  const songProvider = useMemo(() => {
    const candidates = (controller.nodeState?.providers || []).filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('songs.search') &&
      provider.capabilities.includes('songs.present')
    );
    const routedProviderId = controller.nodeState?.routing?.songs;
    if (routedProviderId) {
      return candidates.find(provider => provider.providerId === routedProviderId) || null;
    }
    return candidates.length === 1 ? candidates[0]! : null;
  }, [controller.nodeState]);
  const organizationName = typeof plan.metadata?.organizationName === 'string'
    ? plan.metadata.organizationName
    : '';
  const locationName = typeof plan.metadata?.locationName === 'string'
    ? plan.metadata.locationName
    : '';

  async function executeLinkedSong(
    itemId: string,
    link: ProviderLink
  ) {
    const results = await controller.executeCommand({
      capability: 'songs.present',
      payload: { id: link.externalId },
      targetProviderIds: [link.providerInstanceId],
      liveSessionId: liveSessionId || `service-plan:${plan.id}`,
      serviceItemId: itemId,
      actorId
    });
    const rejected = results.find(result => !result.accepted);
    if (rejected) throw new Error(rejected.errorCode || 'provider_error');
  }

  async function present(itemId: string, providerLinkId?: string) {
    const item = plan.items.find(candidate => candidate.id === itemId);
    if (!item || item.type !== 'song') return;

    setBusyItemId(itemId);
    setMessage(null);
    try {
      const existing = providerLinkId ? linksById.get(providerLinkId) : undefined;
      if (existing) {
        await executeLinkedSong(itemId, existing);
        return;
      }

      if (!songProvider) {
        setMessage(t('offlineRun.providerUnavailable'));
        return;
      }

      setMessage(t('offlineRun.resolving', { title: item.title }));
      const searchResults = await controller.executeCommand({
        capability: 'songs.search',
        payload: {
          text: item.title,
          title: true,
          artist: true,
          fields: 'id,title,artist,key,bpm'
        },
        targetProviderIds: [songProvider.providerId],
        liveSessionId: liveSessionId || `service-plan:${plan.id}`,
        serviceItemId: item.id,
        actorId
      });
      const searchRejected = searchResults.find(result => !result.accepted);
      if (searchRejected) {
        throw new Error(searchRejected.errorCode || 'provider_error');
      }

      const artist = String(item.payload?.artist || '').trim() || undefined;
      const decision = matchExternalSong(
        { title: item.title, artist },
        extractExternalSongs(searchResults)
      );

      if (decision.status !== 'matched') {
        setMessage(t('offlineRun.linkNeedsReview', { title: item.title }));
        return;
      }

      const linkId =
        `local-song-link:${songProvider.providerId}:${item.sourceEntityId || item.id}`;
      const link: ProviderLink = {
        id: linkId,
        organizationId: plan.organizationId,
        venueId: plan.venueId,
        providerInstanceId: songProvider.providerId,
        entityType: 'song',
        musicScaleEntityId: item.sourceEntityId,
        externalId: decision.candidate.id,
        fingerprint:
          `${decision.candidate.title}|${decision.candidate.artist || ''}`,
        lastVerifiedAt: new Date().toISOString(),
        metadata: {
          source: 'local-recovery-auto-link'
        }
      };

      const nextPlan: ServicePlan = {
        ...plan,
        revision: plan.revision + 1,
        items: plan.items.map(candidate =>
          candidate.id === item.id
            ? { ...candidate, providerLinkId: link.id }
            : candidate
        )
      };
      const nextLinks = [
        ...providerLinks.filter(candidate => candidate.id !== link.id),
        link
      ];

      await controller.cacheServicePlan(nextPlan, nextLinks);
      await executeLinkedSong(item.id, link);
      setMessage(null);
    } catch (error) {
      setMessage(t('offlineRun.commandFailed', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    } finally {
      setBusyItemId(null);
    }
  }

  return (
    <section className="offline-run">
      <div className="offline-run-head">
        <div>
          <span className="eyebrow">{t('offlineRun.kicker')}</span>
          <h2>{plan.title}</h2>
          <div className="offline-run-context">
            {organizationName && <strong>{organizationName}</strong>}
            {locationName && <span>{locationName}</span>}
            <time dateTime={plan.scheduledAt}>
              {new Date(plan.scheduledAt).toLocaleString()}
            </time>
          </div>
          <p>{t('offlineRun.description')}</p>
        </div>
        <span className="offline-badge">{t('offlineRun.cached')}</span>
      </div>

      <div className="offline-items">
        {plan.items.map((item, index) => {
          const link = item.providerLinkId ? linksById.get(item.providerLinkId) : undefined;
          return (
            <button
              key={item.id}
              className={[
                controller.nodeState?.state.activeServiceItemId === item.id ? 'active' : '',
                `item-${item.state}`
              ].filter(Boolean).join(' ')}
              disabled={item.type !== 'song' || busyItemId !== null}
              onClick={() => void present(item.id, item.providerLinkId)}
            >
              <b>{String(index + 1).padStart(2, '0')}</b>
              <span>
                <strong>{item.title}</strong>
                <small>
                  {String(item.payload?.artist || '')}
                  {item.payload?.key ? ` · ${item.payload.key}` : ''}
                </small>
              </span>
              <em>
                {busyItemId === item.id
                  ? t('offlineRun.resolvingShort')
                  : item.state === 'completed'
                    ? t('offlineRun.completed')
                    : item.state === 'live'
                      ? t('offlineRun.live')
                      : link
                        ? t('offlineRun.ready')
                        : t('offlineRun.notLinked')}
              </em>
            </button>
          );
        })}
      </div>
      {message && <p className="preflight-message" role="status">{message}</p>}
    </section>
  );
}
