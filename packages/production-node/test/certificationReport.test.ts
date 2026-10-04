import { describe, expect, it } from 'vitest';
import type {
  CapabilitySnapshot,
  LiveNodeRuntimeState,
  LiveSessionEventSummary
} from '@millionsnest/nestlive-production-domain';
import { buildCertificationReport } from '../src/certificationReport';

function runtime(): LiveNodeRuntimeState {
  return {
    revision: 7,
    nodeId: 'node-a',
    updatedAt: '2026-09-24T09:00:00.000Z',
    activeLiveSessionId: 'session-a',
    activeSession: null,
    activeServiceItemId: 'song:item-1',
    providerObservedState: {},
    servicePlan: {
      id: 'plan-a',
      organizationId: 'org-a',
      venueId: 'venue-a',
      liveSystemId: 'system-a',
      title: 'Sunday',
      scheduledAt: '2026-09-27T19:00:00-03:00',
      revision: 1,
      items: [{
        id: 'song:item-1',
        type: 'song',
        title: 'Song',
        sourceEntityId: 'song-a',
        state: 'prepared'
      }]
    },
    providerLinks: [{
      id: 'link-a',
      organizationId: 'org-a',
      venueId: 'venue-a',
      providerInstanceId: 'holyrics-primary',
      entityType: 'song',
      musicScaleEntityId: 'song-a',
      externalId: 'song-external'
    }],
    requests: [],
    scenes: []
  };
}

function summary(): LiveSessionEventSummary {
  return {
    total: 22,
    info: 21,
    warnings: 1,
    errors: 0,
    plannedActions: 18,
    plannedServiceItems: 6,
    adHocActions: 1,
    byType: { 'song.presented': 8 },
    providerCommandResults: 20,
    providerCommandAccepted: 20,
    providerCommandRejected: 0,
    providerLatencySamples: 20,
    providerLatencyP50Ms: 82,
    providerLatencyP95Ms: 142,
    providerLatencyMaxMs: 170,
    startedAt: '2026-09-24T08:00:00.000Z',
    lastEventAt: '2026-09-24T09:00:00.000Z'
  };
}

describe('buildCertificationReport', () => {
  it('records measured evidence without claiming physical certification', () => {
    const providers: CapabilitySnapshot[] = [{
      providerId: 'holyrics-primary',
      capabilities: ['songs.present'],
      health: 'online'
    }];

    const report = buildCertificationReport({
      nodeId: 'node-a',
      version: '0.1.0-alpha.1',
      hostname: 'projection',
      platform: 'win32',
      arch: 'x64',
      runtime: runtime(),
      providers,
      routing: { songs: 'holyrics-primary' },
      pairedDevices: 2,
      discovery: { status: 'online', nearbyNodes: 1 },
      peerCount: 1,
      liveSessionId: 'session-a',
      eventSummary: summary(),
      generatedAt: '2026-09-24T09:01:00.000Z'
    });

    expect(report.automaticSignals.servicePlanCached).toBe(true);
    expect(report.automaticSignals.providerCommandErrorFree).toBe(true);
    expect(report.automaticSignals.providerLatencyBaselineUnder250Ms).toBe(true);
    expect(report.measured.providerLatencyP95Ms).toBe(142);
    expect(report.physicalEvidenceRequired.map(item => item.id))
      .toContain('internet_cut');
    expect(report.physicalEvidenceRequired.map(item => item.id))
      .toContain('command_to_observed_latency');
    expect(report.security.providerSecretsIncluded).toBe(false);
  });

  it('does not invent a latency pass when there are no samples', () => {
    const empty = summary();
    empty.providerCommandResults = 0;
    empty.providerCommandAccepted = 0;
    empty.providerLatencySamples = 0;
    empty.providerLatencyP50Ms = undefined;
    empty.providerLatencyP95Ms = undefined;
    empty.providerLatencyMaxMs = undefined;

    const report = buildCertificationReport({
      nodeId: 'node-a',
      version: '0.1.0-alpha.1',
      hostname: 'projection',
      platform: 'linux',
      arch: 'x64',
      runtime: runtime(),
      providers: [],
      routing: {},
      pairedDevices: 0,
      discovery: { status: 'unavailable', nearbyNodes: 0 },
      peerCount: 0,
      eventSummary: empty
    });

    expect(report.automaticSignals.providerCommandErrorFree).toBeNull();
    expect(report.automaticSignals.providerLatencyBaselineUnder250Ms).toBeNull();
    expect(report.connectivity.providersOperational).toBe(0);
  });
});
