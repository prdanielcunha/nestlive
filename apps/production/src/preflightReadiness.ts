import {
  routeGroupForCapability,
  type Capability,
  type LiveNodeRuntimeState,
  type ProviderRouteGroup,
  type ServiceItem
} from '@millionsnest/nestlive-production-domain';
import type { LiveNodeStateResponse } from './liveNodeClient';

export type ReadinessLevel = 'pass' | 'warning' | 'block';

export interface ProductionReadinessCheck {
  id: string;
  level: ReadinessLevel;
  code: string;
  count?: number;
  providerId?: string;
  itemIds?: string[];
}

interface RequiredCapabilityGroup {
  capability: Capability;
  routeGroup: ProviderRouteGroup;
  items: ServiceItem[];
}

function itemCapability(item: ServiceItem): Capability | null {
  switch (item.type) {
    case 'song':
      return 'songs.present';
    case 'bible':
      return 'bible.present';
    case 'video':
    case 'image':
    case 'audio':
      return 'media.open';
    case 'text':
      return String(item.payload?.source || '') === 'quick-text'
        ? 'text.quick.present'
        : 'text.present';
    case 'announcement':
      return 'announcement.present';
    default:
      return null;
  }
}

function explicitProviderId(
  item: ServiceItem,
  state: LiveNodeRuntimeState
): string | undefined {
  const payloadProviderId = String(item.payload?.providerId || '').trim();
  if (payloadProviderId) return payloadProviderId;

  if (item.providerLinkId) {
    const link = state.providerLinks.find(candidate =>
      candidate.id === item.providerLinkId
    );
    if (link?.providerInstanceId) return link.providerInstanceId;
  }

  return undefined;
}

function providerHealthy(provider: LiveNodeStateResponse['providers'][number]): boolean {
  return provider.health === 'online' || provider.health === 'degraded';
}

export function buildProductionReadinessChecks(
  nodeState: LiveNodeStateResponse,
  scaleHasSongs: boolean
): ProductionReadinessCheck[] {
  const checks: ProductionReadinessCheck[] = [];
  const state = nodeState.state;
  const planItems = state.servicePlan?.items || [];

  const effectiveItems = [...planItems];
  if (
    scaleHasSongs &&
    !effectiveItems.some(item => item.type === 'song')
  ) {
    effectiveItems.push({
      id: 'preflight:implicit-song-content',
      type: 'song',
      title: 'MusicScale songs',
      state: 'planned'
    });
  }

  const grouped = new Map<string, RequiredCapabilityGroup>();
  for (const item of effectiveItems) {
    const capability = itemCapability(item);
    if (!capability) continue;

    const providerId = explicitProviderId(item, state);
    if (providerId) {
      const provider = nodeState.providers.find(candidate =>
        candidate.providerId === providerId
      );
      const supported =
        provider &&
        providerHealthy(provider) &&
        provider.capabilities.includes(capability);

      checks.push({
        id: `item-provider:${item.id}`,
        level: supported ? 'pass' : 'block',
        code: supported
          ? 'item_provider_ready'
          : 'item_provider_unavailable',
        count: 1,
        providerId,
        itemIds: [item.id]
      });
      continue;
    }

    const routeGroup = routeGroupForCapability(capability);
    const key = `${routeGroup}:${capability}`;
    const current = grouped.get(key);
    if (current) current.items.push(item);
    else grouped.set(key, { capability, routeGroup, items: [item] });
  }

  for (const group of grouped.values()) {
    const candidates = nodeState.providers.filter(provider =>
      providerHealthy(provider) &&
      provider.capabilities.includes(group.capability)
    );
    const configuredProviderId = nodeState.routing?.[group.routeGroup];

    if (configuredProviderId) {
      const provider = candidates.find(candidate =>
        candidate.providerId === configuredProviderId
      );
      checks.push({
        id: `route:${group.routeGroup}:${group.capability}`,
        level: provider ? 'pass' : 'block',
        code: provider
          ? 'route_ready'
          : 'configured_route_unavailable',
        count: group.items.length,
        providerId: configuredProviderId,
        itemIds: group.items.map(item => item.id)
      });
      continue;
    }

    if (candidates.length === 1) {
      checks.push({
        id: `route:${group.routeGroup}:${group.capability}`,
        level: 'pass',
        code: 'single_provider_ready',
        count: group.items.length,
        providerId: candidates[0]!.providerId,
        itemIds: group.items.map(item => item.id)
      });
      continue;
    }

    checks.push({
      id: `route:${group.routeGroup}:${group.capability}`,
      level: 'block',
      code: candidates.length
        ? 'route_required'
        : 'capability_unavailable',
      count: group.items.length,
      itemIds: group.items.map(item => item.id)
    });
  }

  const unsupportedItems = planItems.filter(item =>
    !itemCapability(item) &&
    !['custom'].includes(item.type)
  );
  if (unsupportedItems.length) {
    checks.push({
      id: 'manual-plan-items',
      level: 'warning',
      code: 'manual_plan_items',
      count: unsupportedItems.length,
      itemIds: unsupportedItems.map(item => item.id)
    });
  }

  const offlinePeers = (nodeState.peers || []).filter(peer =>
    peer.health === 'offline'
  );
  if (offlinePeers.length) {
    checks.push({
      id: 'offline-peers',
      level: 'warning',
      code: 'offline_peers',
      count: offlinePeers.length
    });
  }

  const selectedVisualProviderId = nodeState.routing?.visual;
  if (selectedVisualProviderId) {
    const selectedVisual = nodeState.providers.find(provider =>
      provider.providerId === selectedVisualProviderId
    );
    checks.push({
      id: 'visual-route',
      level:
        selectedVisual &&
        providerHealthy(selectedVisual) &&
        selectedVisual.capabilities.includes('visual.composition.read')
          ? 'pass'
          : 'block',
      code:
        selectedVisual &&
        providerHealthy(selectedVisual) &&
        selectedVisual.capabilities.includes('visual.composition.read')
          ? 'visual_route_ready'
          : 'visual_route_unavailable',
      providerId: selectedVisualProviderId
    });
  }

  return checks;
}

export function hasBlockingReadiness(
  checks: ProductionReadinessCheck[]
): boolean {
  return checks.some(check => check.level === 'block');
}
