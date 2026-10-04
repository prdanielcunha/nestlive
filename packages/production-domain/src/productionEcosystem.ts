import type {
  Capability,
  EntityId,
  ProviderHealth,
  ServicePlan
} from './types';

export interface AudioRouteAlias {
  id: EntityId;
  name: string;
  providerId: EntityId;
  externalRouteId: string;
  direction: 'input' | 'output' | 'bus' | 'aux';
  tags?: string[];
}

export interface AudioProfile {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  name: string;
  routes: AudioRouteAlias[];
  createdAt: string;
  updatedAt: string;
}

export type LiveTemplateKind =
  | 'service-plan'
  | 'scene-pack'
  | 'routing'
  | 'audio-profile'
  | 'full-production';

export interface LiveTemplate {
  id: EntityId;
  organizationId: EntityId;
  name: string;
  description?: string;
  kind: LiveTemplateKind;
  version: number;
  payload: Record<string, unknown>;
  shared: boolean;
  marketplaceStatus: 'private' | 'review' | 'approved' | 'rejected';
  createdBy: EntityId;
  createdAt: string;
  updatedAt: string;
}

export interface LiveNodeBackupManifest {
  schemaVersion: 1;
  backupId: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  nodeId: EntityId;
  createdAt: string;
  appVersion: string;
  servicePlanId?: EntityId;
  files: Array<{
    key: string;
    sha256: string;
    bytes: number;
    encrypted: boolean;
  }>;
  secretsIncluded: false;
}

export interface FleetNodeStatus {
  nodeId: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  displayName: string;
  health: ProviderHealth;
  lastSeenAt?: string;
  version?: string;
  capabilities: Capability[];
}

export interface FailoverCandidate {
  nodeId: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  health: ProviderHealth;
  servicePlanId?: EntityId;
  servicePlanRevision?: number;
  lastSeenAt?: string;
}

export interface FailoverDecision {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'tenant_mismatch'
    | 'venue_mismatch'
    | 'system_mismatch'
    | 'node_unhealthy'
    | 'plan_missing'
    | 'plan_mismatch'
    | 'stale_plan';
  targetNodeId?: EntityId;
  commandNamespace?: string;
}

export function evaluateFailoverCandidate(input: {
  source: Pick<FailoverCandidate,
    'organizationId' | 'venueId' | 'liveSystemId' | 'servicePlanId' | 'servicePlanRevision'>;
  candidate: FailoverCandidate;
  plan: ServicePlan;
}): FailoverDecision {
  const { source, candidate, plan } = input;

  if (candidate.organizationId !== source.organizationId) {
    return { eligible: false, reason: 'tenant_mismatch' };
  }
  if (candidate.venueId !== source.venueId) {
    return { eligible: false, reason: 'venue_mismatch' };
  }
  if (candidate.liveSystemId !== source.liveSystemId) {
    return { eligible: false, reason: 'system_mismatch' };
  }
  if (!['online', 'degraded'].includes(candidate.health)) {
    return { eligible: false, reason: 'node_unhealthy' };
  }
  if (!candidate.servicePlanId) {
    return { eligible: false, reason: 'plan_missing' };
  }
  if (candidate.servicePlanId !== plan.id || candidate.servicePlanId !== source.servicePlanId) {
    return { eligible: false, reason: 'plan_mismatch' };
  }
  if ((candidate.servicePlanRevision || 0) < plan.revision) {
    return { eligible: false, reason: 'stale_plan' };
  }

  return {
    eligible: true,
    reason: 'eligible',
    targetNodeId: candidate.nodeId,
    commandNamespace: `failover:${plan.id}:r${plan.revision}`
  };
}

export function failoverIdempotencyKey(input: {
  namespace: string;
  originalIdempotencyKey: string;
}): string {
  return `${input.namespace}:${input.originalIdempotencyKey}`;
}

export function assertFleetTenantIsolation(
  organizationId: string,
  nodes: FleetNodeStatus[]
): FleetNodeStatus[] {
  return nodes.filter(node => node.organizationId === organizationId);
}
