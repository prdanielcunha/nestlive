import type { SyncEntityKind } from '@millionsnest/nestlive-production-domain';

export const LIVE_COLLECTIONS = {
  venues: 'musicScaleLiveVenues',
  systems: 'musicScaleLiveSystems',
  nodes: 'musicScaleLiveNodes',
  fleetPresence: 'musicScaleLiveFleetPresence',
  profiles: 'musicScaleLiveProfiles',
  scenes: 'musicScaleLiveScenes',
  automations: 'musicScaleLiveAutomations',
  providerLinks: 'musicScaleLiveProviderLinks',
  servicePlans: 'musicScaleLiveServicePlans',
  sessions: 'musicScaleLiveSessions',
  requests: 'musicScaleLiveRequests',
  presence: 'musicScaleLivePresence',
  events: 'musicScaleLiveEvents',
  mediaAssets: 'musicScaleLiveMediaAssets',
  sharedConfig: 'musicScaleLiveSharedConfig',
  routes: 'musicScaleLiveRoutes',
  signalTopologies: 'musicScaleLiveSignalTopologies',
  audioProfiles: 'musicScaleLiveAudioProfiles',
  templates: 'musicScaleLiveTemplates',
  changeHistory: 'musicScaleLiveChangeHistory'
} as const;

export const SYNC_COLLECTION_BY_ENTITY: Record<SyncEntityKind, string> = {
  servicePlan: LIVE_COLLECTIONS.servicePlans,
  providerLink: LIVE_COLLECTIONS.providerLinks,
  scene: LIVE_COLLECTIONS.scenes,
  request: LIVE_COLLECTIONS.requests,
  presence: LIVE_COLLECTIONS.presence,
  liveConfig: LIVE_COLLECTIONS.sharedConfig,
  route: LIVE_COLLECTIONS.routes,
  signalTopology: LIVE_COLLECTIONS.signalTopologies,
  audioProfile: LIVE_COLLECTIONS.audioProfiles,
  template: LIVE_COLLECTIONS.templates
};
