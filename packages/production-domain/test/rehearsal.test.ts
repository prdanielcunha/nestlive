import { describe, expect, it } from 'vitest';
import type {
  CapabilitySnapshot,
  ProviderLink,
  Scene,
  ServicePlan
} from '../src/types';
import { rehearseServicePlan } from '../src/rehearsal';

const plan: ServicePlan = {
  id: 'plan-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  liveSystemId: 'system-1',
  title: 'Sunday',
  scheduledAt: '2026-09-27T19:00:00-03:00',
  revision: 1,
  items: [
    {
      id: 'song:item-1',
      type: 'song',
      title: 'Amazing Grace',
      sourceEntityId: 'song-1',
      state: 'prepared'
    }
  ]
};

const link: ProviderLink = {
  id: 'link-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  providerInstanceId: 'holyrics-primary',
  entityType: 'song',
  musicScaleEntityId: 'song-1',
  externalId: 'holyrics-song-1'
};

const provider = (
  providerId: string,
  capabilities: CapabilitySnapshot['capabilities'],
  health: CapabilitySnapshot['health'] = 'online'
): CapabilitySnapshot => ({
  providerId,
  capabilities,
  health
});

describe('rehearseServicePlan', () => {
  it('certifies a linked song without sending commands', () => {
    const report = rehearseServicePlan({
      plan,
      providerLinks: [link],
      providers: [provider('holyrics-primary', ['songs.present'])]
    });

    expect(report.safeToArm).toBe(true);
    expect(report.readyItems).toBe(1);
    expect(report.blockers).toBe(0);
    expect(report.simulatedCommands).toBe(0);
  });

  it('blocks an offline-prepared song without a provider link', () => {
    const report = rehearseServicePlan({
      plan,
      providerLinks: [],
      providers: [provider('holyrics-primary', ['songs.present'])]
    });

    expect(report.safeToArm).toBe(false);
    expect(report.findings.some(item => item.code === 'provider_link_missing')).toBe(true);
  });

  it('blocks ambiguous routing when more than one provider can own the capability', () => {
    const unlinkedPlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'bible:item-1',
        type: 'bible',
        title: 'John 3:16',
        state: 'prepared'
      }]
    };

    const report = rehearseServicePlan({
      plan: unlinkedPlan,
      providerLinks: [],
      providers: [
        provider('holyrics-primary', ['bible.present']),
        provider('propresenter-primary', ['bible.present'])
      ]
    });

    expect(report.safeToArm).toBe(false);
    expect(report.findings.some(item => item.code === 'route_ambiguous')).toBe(true);
  });

  it('accepts an explicit route for an otherwise ambiguous capability', () => {
    const unlinkedPlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'bible:item-1',
        type: 'bible',
        title: 'John 3:16',
        state: 'prepared'
      }]
    };

    const report = rehearseServicePlan({
      plan: unlinkedPlan,
      providerLinks: [],
      providers: [
        provider('holyrics-primary', ['bible.present']),
        provider('propresenter-primary', ['bible.present'])
      ],
      routing: { bible: 'holyrics-primary' }
    });

    expect(report.safeToArm).toBe(true);
    expect(report.items[0]?.providerId).toBe('holyrics-primary');
  });

  it('checks every scene action without executing it', () => {
    const scene: Scene = {
      id: 'scene-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      liveSystemId: 'system-1',
      name: 'Message',
      actions: [
        {
          id: 'action-1',
          capability: 'presentation.take',
          targetProviderIds: ['propresenter-primary'],
          outputTargets: ['main'],
          payload: {},
          safetyLevel: 'normal'
        },
        {
          id: 'action-2',
          capability: 'visual.clip.trigger',
          targetProviderIds: ['resolume-primary'],
          outputTargets: ['main'],
          payload: {},
          safetyLevel: 'normal',
          offsetMs: 120
        }
      ]
    };

    const scenePlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'scene:item-1',
        type: 'scene',
        title: 'Message scene',
        sourceEntityId: 'scene-1',
        state: 'prepared'
      }]
    };

    const report = rehearseServicePlan({
      plan: scenePlan,
      providerLinks: [],
      providers: [
        provider('propresenter-primary', ['presentation.take']),
        provider('resolume-primary', ['visual.clip.trigger'])
      ],
      scenes: [scene]
    });

    expect(report.safeToArm).toBe(true);
    expect(report.simulatedCommands).toBe(0);
    expect(report.findings.some(item => item.code === 'scene_ready')).toBe(true);
  });

  it('blocks a scene whose provider is unavailable', () => {
    const scene: Scene = {
      id: 'scene-1',
      organizationId: 'org-1',
      venueId: 'venue-1',
      liveSystemId: 'system-1',
      name: 'Message',
      actions: [{
        id: 'action-1',
        capability: 'presentation.take',
        targetProviderIds: ['propresenter-primary'],
        outputTargets: ['main'],
        payload: {},
        safetyLevel: 'normal'
      }]
    };

    const scenePlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'scene:item-1',
        type: 'scene',
        title: 'Message scene',
        sourceEntityId: 'scene-1',
        state: 'prepared'
      }]
    };

    const report = rehearseServicePlan({
      plan: scenePlan,
      providerLinks: [],
      providers: [
        provider('propresenter-primary', ['presentation.take'], 'offline')
      ],
      scenes: [scene]
    });

    expect(report.safeToArm).toBe(false);
    expect(report.findings.some(item => item.code === 'scene_action_target_invalid')).toBe(true);
  });

  it('blocks planned media when the referenced asset is not in the offline cache', () => {
    const mediaPlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'video-1',
        type: 'video',
        title: 'Abertura',
        state: 'prepared',
        payload: { assetId: 'asset-opening' }
      }]
    };

    const report = rehearseServicePlan({
      plan: mediaPlan,
      providerLinks: [],
      providers: [{
        providerId: 'holyrics-primary',
        health: 'online',
        capabilities: ['media.open']
      }],
      offlineMedia: []
    });

    expect(report.safeToArm).toBe(false);
    expect(report.findings.some(finding => finding.code === 'media_cache_missing')).toBe(true);
    expect(report.simulatedCommands).toBe(0);
  });

  it('accepts a referenced media asset when the offline cache confirms it ready', () => {
    const mediaPlan: ServicePlan = {
      ...plan,
      items: [{
        id: 'video-1',
        type: 'video',
        title: 'Abertura',
        state: 'prepared',
        payload: { assetId: 'asset-opening' }
      }]
    };

    const report = rehearseServicePlan({
      plan: mediaPlan,
      providerLinks: [],
      providers: [{
        providerId: 'holyrics-primary',
        health: 'online',
        capabilities: ['media.open']
      }],
      offlineMedia: [{
        id: 'asset-opening',
        fileName: 'abertura.mp4',
        ready: true
      }]
    });

    expect(report.findings.some(finding => finding.code === 'media_cache_missing')).toBe(false);
    expect(report.safeToArm).toBe(true);
  });
});
