import { useEffect } from 'react';
import type { useLiveNode } from './useLiveNode';
import { liveFeatureFlags } from './featureFlags';
import { upsertCloudFleetPresence } from './liveCloudRepository';

type Controller = ReturnType<typeof useLiveNode>;

export function CloudFleetPulse({
  controller,
  actorId
}: {
  controller: Controller;
  actorId: string;
}) {
  const credential = controller.credential;
  const health = controller.health;

  useEffect(() => {
    if (
      !liveFeatureFlags.servicePlanWrites ||
      !credential ||
      credential.collaboration ||
      !health
    ) {
      return;
    }

    let cancelled = false;
    const publish = async () => {
      if (cancelled) return;
      await upsertCloudFleetPresence({
        organizationId: credential.binding.organizationId,
        venueId: credential.binding.venueId,
        liveSystemId: credential.binding.liveSystemId,
        nodeId: health.nodeId,
        displayName: health.displayName || health.hostname || health.nodeId,
        health: health.health,
        providers: health.providers,
        providersOnline: health.providersOnline,
        version: health.version,
        lastSeenAt: new Date().toISOString(),
        updatedBy: actorId
      }).catch(() => undefined);
    };

    void publish();
    const timer = window.setInterval(() => void publish(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    actorId,
    credential?.baseUrl,
    credential?.binding.organizationId,
    credential?.binding.venueId,
    credential?.binding.liveSystemId,
    credential?.collaboration,
    health?.nodeId,
    health?.displayName,
    health?.hostname,
    health?.health,
    health?.providers,
    health?.providersOnline,
    health?.version
  ]);

  return null;
}
