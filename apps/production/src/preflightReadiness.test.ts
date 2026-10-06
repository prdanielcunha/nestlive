import { describe, expect, it } from 'vitest';
import type {
  LiveNodeRuntimeState,
  ProviderLink,
  ServicePlan
} from '@millionsnest/nestlive-production-domain';
import type { LiveNodeStateResponse } from './liveNodeClient';
import {
  buildProductionReadinessChecks,
  hasBlockingReadiness
} from './preflightReadiness';

function plan(items: ServicePlan['items']): ServicePlan {
  return {
    id: 'plan-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    liveSystemId: 'system-1',
    title: 'Culto',
    scheduledAt: '2026-09-22T19:00:00-03:00',
    items,
    revision: 1
  };
}

function state(
  overrides: Partial<LiveNodeStateResponse> = {},
  runtime: Partial<LiveNodeRuntimeState> = {}
): LiveNodeStateResponse {
  return {
    nodeId: 'node-1',
    state: {
      revision: 1,
      nodeId: 'node-1',
      updatedAt: '2026-09-22T12:00:00.000Z',
      activeLiveSessionId: 'session-1',
      activeSession: null,
      activeServiceItemId: null,
      providerObservedState: {},
      servicePlan: null,
      providerLinks: [],
      requests: [],
      scenes: [],
      ...runtime
    },
    providers: [],
    ...overrides
  };
}

describe('production preflight readiness', () => {
  it('passes a song whose mapped provider is healthy and capable', () => {
    const link: ProviderLink = {
      id: 'link-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      providerInstanceId: 'holyrics-1',
      entityType: 'song',
      externalId: 'song-44'
    };
    const node = state({
      providers: [{
        providerId: 'holyrics-1',
        capabilities: ['songs.present'],
        health: 'online'
      }]
    }, {
      providerLinks: [link],
      servicePlan: plan([{
        id: 'item-1',
        type: 'song',
        title: 'Promessas',
        state: 'planned',
        providerLinkId: link.id
      }])
    });

    const checks = buildProductionReadinessChecks(node, true);
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'item-provider:item-1',
        level: 'pass',
        code: 'item_provider_ready',
        providerId: 'holyrics-1'
      })
    ]));
    expect(hasBlockingReadiness(checks)).toBe(false);
  });

  it('blocks ambiguous Bible routing when the plan needs Bible', () => {
    const node = state({
      providers: [
        {
          providerId: 'holyrics-1',
          capabilities: ['bible.present'],
          health: 'online'
        },
        {
          providerId: 'propresenter-1',
          capabilities: ['bible.present'],
          health: 'online'
        }
      ]
    }, {
      servicePlan: plan([{
        id: 'bible-1',
        type: 'bible',
        title: 'João 3:16',
        state: 'planned',
        payload: { reference: 'João 3:16' }
      }])
    });

    const checks = buildProductionReadinessChecks(node, false);
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'block',
        code: 'route_required'
      })
    ]));
    expect(hasBlockingReadiness(checks)).toBe(true);
  });

  it('blocks a configured media route that is not healthy', () => {
    const node = state({
      routing: { media: 'media-1' },
      providers: [{
        providerId: 'media-1',
        capabilities: ['media.open'],
        health: 'offline'
      }]
    }, {
      servicePlan: plan([{
        id: 'video-1',
        type: 'video',
        title: 'Abertura',
        state: 'planned',
        payload: { file: 'abertura.mp4' }
      }])
    });

    expect(buildProductionReadinessChecks(node, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'block',
          code: 'configured_route_unavailable',
          providerId: 'media-1'
        })
      ])
    );
  });

  it('warns about manual plan items and offline peers without inventing support', () => {
    const node = state({
      peers: [{
        nodeId: 'node-2',
        displayName: 'Arena PC',
        baseUrl: 'http://192.168.1.22:4317',
        health: 'offline',
        providers: 1,
        providersOnline: 0
      }]
    }, {
      servicePlan: plan([{
        id: 'macro-1',
        type: 'macro',
        title: 'Abrir transmissão',
        state: 'planned'
      }])
    });

    const checks = buildProductionReadinessChecks(node, false);
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'manual_plan_items', level: 'warning' }),
      expect.objectContaining({ code: 'offline_peers', level: 'warning' })
    ]));
    expect(hasBlockingReadiness(checks)).toBe(false);
  });

  it('blocks a selected visual route when its provider is unavailable', () => {
    const node = state({
      routing: { visual: 'resolume-1' },
      providers: [{
        providerId: 'resolume-1',
        capabilities: ['visual.composition.read'],
        health: 'offline'
      }]
    });

    expect(buildProductionReadinessChecks(node, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'visual-route',
          level: 'block',
          code: 'visual_route_unavailable'
        })
      ])
    );
  });
});
