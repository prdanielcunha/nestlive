import type {
  CapabilitySnapshot,
  LiveNodeRuntimeState,
  LiveSessionEventSummary
} from '@millionsnest/nestlive-production-domain';
import type { ProviderRouteGroup } from '@millionsnest/nestlive-production-domain';

export interface CertificationReportInput {
  nodeId: string;
  version: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  runtime: LiveNodeRuntimeState;
  providers: CapabilitySnapshot[];
  routing: Partial<Record<ProviderRouteGroup, string>>;
  pairedDevices: number;
  discovery: {
    status: 'idle' | 'starting' | 'online' | 'unavailable';
    nearbyNodes: number;
  };
  peerCount: number;
  liveSessionId?: string;
  eventSummary: LiveSessionEventSummary;
  generatedAt?: string;
}

export interface CertificationEvidenceGap {
  id:
    | 'physical_device_matrix'
    | 'internet_cut'
    | 'provider_version_matrix'
    | 'final_output_validation'
    | 'command_to_observed_latency'
    | 'signed_installer_validation'
    | 'volunteer_usability';
  reason: string;
}

export interface LiveNodeCertificationReport {
  schemaVersion: 1;
  generatedAt: string;
  product: 'NestLive Node';
  release: {
    version: string;
    nodeId: string;
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  session: {
    liveSessionId: string | null;
    servicePlanId: string | null;
    servicePlanItems: number;
    providerLinks: number;
    activeServiceItemId: string | null;
    runtimeRevision: number;
  };
  connectivity: {
    pairedDevices: number;
    discoveryStatus: CertificationReportInput['discovery']['status'];
    nearbyNodes: number;
    pairedPeerNodes: number;
    providers: number;
    providersOperational: number;
    providersOffline: number;
  };
  routing: Partial<Record<ProviderRouteGroup, string>>;
  measured: {
    events: number;
    warnings: number;
    errors: number;
    plannedActions: number;
    plannedServiceItems: number;
    adHocActions: number;
    providerCommandResults: number;
    providerCommandAccepted: number;
    providerCommandRejected: number;
    providerLatencySamples: number;
    providerLatencyP50Ms: number | null;
    providerLatencyP95Ms: number | null;
    providerLatencyMaxMs: number | null;
    startedAt: string | null;
    lastEventAt: string | null;
  };
  automaticSignals: {
    servicePlanCached: boolean;
    hasProviderLinks: boolean;
    hasOperationalProvider: boolean;
    providerCommandErrorFree: boolean | null;
    providerLatencyBaselineUnder250Ms: boolean | null;
  };
  physicalEvidenceRequired: CertificationEvidenceGap[];
  security: {
    providerSecretsIncluded: false;
    pairingTokensIncluded: false;
  };
}

function valueOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildCertificationReport(
  input: CertificationReportInput
): LiveNodeCertificationReport {
  const operational = input.providers.filter(
    provider => provider.health === 'online' || provider.health === 'degraded'
  ).length;
  const providerErrorFree =
    input.eventSummary.providerCommandResults > 0
      ? input.eventSummary.providerCommandRejected === 0
      : null;
  const p95 = valueOrNull(input.eventSummary.providerLatencyP95Ms);

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt || new Date().toISOString(),
    product: 'NestLive Node',
    release: {
      version: input.version,
      nodeId: input.nodeId,
      hostname: input.hostname,
      platform: input.platform,
      arch: input.arch
    },
    session: {
      liveSessionId: input.liveSessionId || input.runtime.activeLiveSessionId || null,
      servicePlanId: input.runtime.servicePlan?.id || null,
      servicePlanItems: input.runtime.servicePlan?.items.length || 0,
      providerLinks: input.runtime.providerLinks.length,
      activeServiceItemId: input.runtime.activeServiceItemId || null,
      runtimeRevision: input.runtime.revision
    },
    connectivity: {
      pairedDevices: input.pairedDevices,
      discoveryStatus: input.discovery.status,
      nearbyNodes: input.discovery.nearbyNodes,
      pairedPeerNodes: input.peerCount,
      providers: input.providers.length,
      providersOperational: operational,
      providersOffline: input.providers.length - operational
    },
    routing: { ...input.routing },
    measured: {
      events: input.eventSummary.total,
      warnings: input.eventSummary.warnings,
      errors: input.eventSummary.errors,
      plannedActions: input.eventSummary.plannedActions,
      plannedServiceItems: input.eventSummary.plannedServiceItems,
      adHocActions: input.eventSummary.adHocActions,
      providerCommandResults: input.eventSummary.providerCommandResults,
      providerCommandAccepted: input.eventSummary.providerCommandAccepted,
      providerCommandRejected: input.eventSummary.providerCommandRejected,
      providerLatencySamples: input.eventSummary.providerLatencySamples,
      providerLatencyP50Ms: valueOrNull(input.eventSummary.providerLatencyP50Ms),
      providerLatencyP95Ms: p95,
      providerLatencyMaxMs: valueOrNull(input.eventSummary.providerLatencyMaxMs),
      startedAt: input.eventSummary.startedAt || null,
      lastEventAt: input.eventSummary.lastEventAt || null
    },
    automaticSignals: {
      servicePlanCached: Boolean(input.runtime.servicePlan),
      hasProviderLinks: input.runtime.providerLinks.length > 0,
      hasOperationalProvider: operational > 0,
      providerCommandErrorFree: providerErrorFree,
      // This is only the adapter/provider latency baseline captured in CommandResult.
      // It is intentionally not treated as the full command-to-observed-state gate.
      providerLatencyBaselineUnder250Ms: p95 == null ? null : p95 < 250
    },
    physicalEvidenceRequired: [
      {
        id: 'physical_device_matrix',
        reason: 'Windows/iPad, Windows/Android and multi-PC behavior requires real devices.'
      },
      {
        id: 'internet_cut',
        reason: 'WAN loss while preserving the LAN cannot be proven from stored Node events alone.'
      },
      {
        id: 'provider_version_matrix',
        reason: 'Supported Holyrics, Resolume and ProPresenter versions must be exercised physically.'
      },
      {
        id: 'final_output_validation',
        reason: 'The final LED/projector/media-plane output must be visually confirmed by a human.'
      },
      {
        id: 'command_to_observed_latency',
        reason: 'Provider command latency is measured, but full command-to-observed-state p95 needs the certified topology.'
      },
      {
        id: 'signed_installer_validation',
        reason: 'Signature/notarization trust must be validated on the target operating systems.'
      },
      {
        id: 'volunteer_usability',
        reason: 'Five-minute setup and volunteer operation require an untrained human acceptance run.'
      }
    ],
    security: {
      providerSecretsIncluded: false,
      pairingTokensIncluded: false
    }
  };
}
