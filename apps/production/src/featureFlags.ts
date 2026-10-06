const enabled = (value: unknown, fallback = false) =>
  typeof value === 'string' ? value === 'true' : fallback;

export const liveFeatureFlags = {
  sharedMusicScaleReadBridge: true,
  liveNodeTransport: true,
  providerAdapters: true,
  servicePlanWrites: enabled(import.meta.env.VITE_LIVE_CLOUD_WRITES, false),
  smartRehearsal: enabled(import.meta.env.VITE_LIVE_SMART_REHEARSAL, false),
  serviceReview: enabled(import.meta.env.VITE_LIVE_SERVICE_REVIEW, false),
  aiAssist: enabled(import.meta.env.VITE_LIVE_AI_ASSIST, false),
  remoteControl: enabled(import.meta.env.VITE_LIVE_REMOTE_CONTROL, false)
} as const;
