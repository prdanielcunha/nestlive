import type {
  Capability,
  CapabilitySnapshot,
  ProviderLink,
  Scene,
  SceneAction,
  ServiceItem,
  ServicePlan
} from './types';
import {
  routeGroupForCapability,
  type ProviderRouteGroup
} from './routing';

export type RehearsalSeverity = 'info' | 'warning' | 'blocker';

export interface RehearsalFinding {
  id: string;
  severity: RehearsalSeverity;
  code:
    | 'plan_empty'
    | 'duplicate_service_item'
    | 'provider_link_missing'
    | 'provider_missing'
    | 'provider_offline'
    | 'capability_missing'
    | 'route_ambiguous'
    | 'route_target_invalid'
    | 'scene_missing'
    | 'scene_action_output_missing'
    | 'scene_action_target_invalid'
    | 'media_cache_missing'
    | 'media_cache_unknown'
    | 'item_ready'
    | 'scene_ready';
  message: string;
  serviceItemId?: string;
  sceneId?: string;
  actionId?: string;
  capability?: Capability;
  providerId?: string;
}

export interface RehearsalItemResult {
  serviceItemId: string;
  title: string;
  capability?: Capability;
  providerId?: string;
  ready: boolean;
  findings: RehearsalFinding[];
}

export interface ServicePlanRehearsalReport {
  planId: string;
  revision: number;
  generatedAt: string;
  safeToArm: boolean;
  blockers: number;
  warnings: number;
  readyItems: number;
  totalItems: number;
  items: RehearsalItemResult[];
  findings: RehearsalFinding[];
  providerSnapshot: Array<{
    providerId: string;
    health: CapabilitySnapshot['health'];
    capabilityCount: number;
  }>;
  simulatedCommands: 0;
}

export interface RehearsalInput {
  plan: ServicePlan;
  providerLinks: ProviderLink[];
  providers: CapabilitySnapshot[];
  routing?: Partial<Record<ProviderRouteGroup, string>>;
  scenes?: Scene[];
  offlineMedia?: Array<{
    id: string;
    fileName?: string;
    sha256?: string;
    ready: boolean;
  }>;
  now?: Date;
}

function itemCapability(item: ServiceItem): Capability | undefined {
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
      return 'text.present';
    case 'announcement':
      return 'announcement.present';
    case 'presentation':
      return 'presentation.take';
    case 'macro':
      return 'automation.trigger';
    default:
      return undefined;
  }
}

function explicitProviderId(
  item: ServiceItem,
  providerLinks: ProviderLink[]
): string | undefined {
  if (typeof item.payload?.providerId === 'string' && item.payload.providerId.trim()) {
    return item.payload.providerId.trim();
  }

  const link = item.providerLinkId
    ? providerLinks.find(candidate => candidate.id === item.providerLinkId)
    : item.sourceEntityId
      ? providerLinks.find(candidate =>
          candidate.musicScaleEntityId === item.sourceEntityId
        )
      : undefined;

  return link?.providerInstanceId;
}

function findProvider(
  providers: CapabilitySnapshot[],
  providerId: string
): CapabilitySnapshot | undefined {
  return providers.find(candidate => candidate.providerId === providerId);
}

function supports(
  provider: CapabilitySnapshot,
  capability: Capability
): boolean {
  return provider.capabilities.includes(capability);
}

function healthy(provider: CapabilitySnapshot): boolean {
  return provider.health === 'online' || provider.health === 'degraded';
}

function compatibleProviders(
  providers: CapabilitySnapshot[],
  capability: Capability
): CapabilitySnapshot[] {
  return providers.filter(provider =>
    supports(provider, capability) && healthy(provider)
  );
}

function resolveProvider(
  capability: Capability,
  explicitProvider: string | undefined,
  providers: CapabilitySnapshot[],
  routing: Partial<Record<ProviderRouteGroup, string>>
): {
  providerId?: string;
  findings: RehearsalFinding[];
} {
  const findings: RehearsalFinding[] = [];

  if (explicitProvider) {
    const provider = findProvider(providers, explicitProvider);
    if (!provider) {
      findings.push({
        id: `provider-missing:${explicitProvider}:${capability}`,
        severity: 'blocker',
        code: 'provider_missing',
        message: `Provider ${explicitProvider} is not available.`,
        capability,
        providerId: explicitProvider
      });
      return { providerId: explicitProvider, findings };
    }

    if (!supports(provider, capability)) {
      findings.push({
        id: `capability-missing:${explicitProvider}:${capability}`,
        severity: 'blocker',
        code: 'capability_missing',
        message: `${explicitProvider} does not expose ${capability}.`,
        capability,
        providerId: explicitProvider
      });
    }

    if (!healthy(provider)) {
      findings.push({
        id: `provider-offline:${explicitProvider}:${capability}`,
        severity: 'blocker',
        code: 'provider_offline',
        message: `${explicitProvider} is not currently reachable.`,
        capability,
        providerId: explicitProvider
      });
    }

    return { providerId: explicitProvider, findings };
  }

  const routeGroup = routeGroupForCapability(capability);
  const routedProviderId = routing[routeGroup];
  if (routedProviderId) {
    const routed = findProvider(providers, routedProviderId);
    if (!routed || !supports(routed, capability) || !healthy(routed)) {
      findings.push({
        id: `route-invalid:${routeGroup}:${routedProviderId}:${capability}`,
        severity: 'blocker',
        code: 'route_target_invalid',
        message: `The configured ${routeGroup} route cannot execute ${capability}.`,
        capability,
        providerId: routedProviderId
      });
      return { providerId: routedProviderId, findings };
    }
    return { providerId: routedProviderId, findings };
  }

  const candidates = compatibleProviders(providers, capability);
  if (candidates.length === 1) {
    return { providerId: candidates[0]!.providerId, findings };
  }

  if (candidates.length === 0) {
    findings.push({
      id: `capability-unavailable:${capability}`,
      severity: 'blocker',
      code: 'capability_missing',
      message: `No online provider can execute ${capability}.`,
      capability
    });
    return { findings };
  }

  findings.push({
    id: `route-ambiguous:${routeGroup}:${capability}`,
    severity: 'blocker',
    code: 'route_ambiguous',
    message: `More than one provider can execute ${capability}; choose the ${routeGroup} route before Live.`,
    capability
  });
  return { findings };
}

function validateAction(
  action: SceneAction,
  scene: Scene,
  providers: CapabilitySnapshot[],
  routing: Partial<Record<ProviderRouteGroup, string>>
): RehearsalFinding[] {
  const findings: RehearsalFinding[] = [];

  if (!action.outputTargets.length) {
    findings.push({
      id: `scene-output-missing:${scene.id}:${action.id}`,
      severity: 'warning',
      code: 'scene_action_output_missing',
      message: `Scene action ${action.id} has no explicit output target.`,
      sceneId: scene.id,
      actionId: action.id,
      capability: action.capability
    });
  }

  if (action.targetProviderIds.length) {
    for (const providerId of action.targetProviderIds) {
      const provider = findProvider(providers, providerId);
      if (!provider || !healthy(provider) || !supports(provider, action.capability)) {
        findings.push({
          id: `scene-target-invalid:${scene.id}:${action.id}:${providerId}`,
          severity: 'blocker',
          code: 'scene_action_target_invalid',
          message: `Scene action ${action.id} cannot run on ${providerId}.`,
          sceneId: scene.id,
          actionId: action.id,
          capability: action.capability,
          providerId
        });
      }
    }
    return findings;
  }

  const resolved = resolveProvider(
    action.capability,
    undefined,
    providers,
    routing
  );
  return findings.concat(
    resolved.findings.map(finding => ({
      ...finding,
      id: `scene:${scene.id}:${action.id}:${finding.id}`,
      sceneId: scene.id,
      actionId: action.id
    }))
  );
}

function sceneForItem(item: ServiceItem, scenes: Scene[]): Scene | undefined {
  const sceneId =
    (typeof item.payload?.sceneId === 'string' && item.payload.sceneId.trim()) ||
    item.sourceEntityId ||
    '';
  return sceneId ? scenes.find(scene => scene.id === sceneId) : undefined;
}

export function rehearseServicePlan(input: RehearsalInput): ServicePlanRehearsalReport {
  const routing = input.routing || {};
  const scenes = input.scenes || [];
  const findings: RehearsalFinding[] = [];
  const items: RehearsalItemResult[] = [];

  if (!input.plan.items.length) {
    findings.push({
      id: 'plan-empty',
      severity: 'warning',
      code: 'plan_empty',
      message: 'The service plan has no items to rehearse.'
    });
  }

  const seenItemIds = new Set<string>();
  for (const item of input.plan.items) {
    const itemFindings: RehearsalFinding[] = [];

    if (seenItemIds.has(item.id)) {
      itemFindings.push({
        id: `duplicate-service-item:${item.id}`,
        severity: 'blocker',
        code: 'duplicate_service_item',
        message: `Service item ${item.id} appears more than once.`,
        serviceItemId: item.id
      });
    }
    seenItemIds.add(item.id);

    if (item.type === 'scene') {
      const scene = sceneForItem(item, scenes);
      if (!scene) {
        itemFindings.push({
          id: `scene-missing:${item.id}`,
          severity: 'blocker',
          code: 'scene_missing',
          message: `Scene for “${item.title}” is not cached on this Live Node.`,
          serviceItemId: item.id
        });
      } else {
        for (const action of scene.actions) {
          itemFindings.push(
            ...validateAction(action, scene, input.providers, routing)
              .map(finding => ({ ...finding, serviceItemId: item.id }))
          );
        }
        if (!itemFindings.some(finding => finding.severity === 'blocker')) {
          itemFindings.push({
            id: `scene-ready:${item.id}`,
            severity: 'info',
            code: 'scene_ready',
            message: `Scene “${scene.name}” is structurally ready.`,
            serviceItemId: item.id,
            sceneId: scene.id
          });
        }
      }

      const ready = !itemFindings.some(finding => finding.severity === 'blocker');
      items.push({
        serviceItemId: item.id,
        title: item.title,
        ready,
        findings: itemFindings
      });
      findings.push(...itemFindings);
      continue;
    }

    if (item.type === 'video' || item.type === 'image' || item.type === 'audio') {
      const offlineMedia = input.offlineMedia || [];
      const assetId =
        typeof item.payload?.assetId === 'string'
          ? item.payload.assetId.trim()
          : typeof item.payload?.liveDropAssetId === 'string'
            ? item.payload.liveDropAssetId.trim()
            : '';
      const fileName =
        typeof item.payload?.fileName === 'string'
          ? item.payload.fileName.trim()
          : typeof item.payload?.file === 'string'
            ? item.payload.file.trim()
            : '';
      const fingerprint =
        typeof item.payload?.sha256 === 'string'
          ? item.payload.sha256.trim().toLowerCase()
          : '';

      if (assetId || fileName || fingerprint) {
        const cached = offlineMedia.find(asset =>
          asset.ready && (
            (assetId && asset.id === assetId) ||
            (fileName && asset.fileName === fileName) ||
            (fingerprint && asset.sha256?.toLowerCase() === fingerprint)
          )
        );
        if (!cached) {
          itemFindings.push({
            id: `media-cache-missing:${item.id}`,
            severity: 'blocker',
            code: 'media_cache_missing',
            message: `“${item.title}” is referenced by the plan but is not available in the known offline media cache.`,
            serviceItemId: item.id
          });
        }
      } else if (item.payload?.remoteOnly === true || item.payload?.cloudUrl) {
        itemFindings.push({
          id: `media-cache-unknown:${item.id}`,
          severity: 'warning',
          code: 'media_cache_unknown',
          message: `“${item.title}” has a remote media reference with no verified offline cache identity.`,
          serviceItemId: item.id
        });
      }
    }

    const capability = itemCapability(item);
    if (!capability) {
      items.push({
        serviceItemId: item.id,
        title: item.title,
        ready: true,
        findings: []
      });
      continue;
    }

    if (
      item.type === 'song' &&
      item.sourceEntityId &&
      !item.providerLinkId &&
      !input.providerLinks.some(link =>
        link.musicScaleEntityId === item.sourceEntityId
      )
    ) {
      itemFindings.push({
        id: `provider-link-missing:${item.id}`,
        severity: 'blocker',
        code: 'provider_link_missing',
        message: `“${item.title}” has no verified provider link for offline execution.`,
        serviceItemId: item.id,
        capability
      });
    }

    const providerId = explicitProviderId(item, input.providerLinks);
    const resolved = resolveProvider(
      capability,
      providerId,
      input.providers,
      routing
    );
    itemFindings.push(
      ...resolved.findings.map(finding => ({
        ...finding,
        serviceItemId: item.id
      }))
    );

    const ready = !itemFindings.some(finding => finding.severity === 'blocker');
    if (ready) {
      itemFindings.push({
        id: `item-ready:${item.id}`,
        severity: 'info',
        code: 'item_ready',
        message: `“${item.title}” can be prepared without sending a provider command.`,
        serviceItemId: item.id,
        capability,
        providerId: resolved.providerId
      });
    }

    items.push({
      serviceItemId: item.id,
      title: item.title,
      capability,
      providerId: resolved.providerId,
      ready,
      findings: itemFindings
    });
    findings.push(...itemFindings);
  }

  const blockers = findings.filter(finding => finding.severity === 'blocker').length;
  const warnings = findings.filter(finding => finding.severity === 'warning').length;

  return {
    planId: input.plan.id,
    revision: input.plan.revision,
    generatedAt: (input.now || new Date()).toISOString(),
    safeToArm: blockers === 0,
    blockers,
    warnings,
    readyItems: items.filter(item => item.ready).length,
    totalItems: items.length,
    items,
    findings,
    providerSnapshot: input.providers.map(provider => ({
      providerId: provider.providerId,
      health: provider.health,
      capabilityCount: provider.capabilities.length
    })),
    simulatedCommands: 0
  };
}
