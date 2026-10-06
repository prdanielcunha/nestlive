export const NESTLIVE_FEATURE_FLAGS = {
  live_mix: false
} as const;

export type NestLiveFeatureFlag = keyof typeof NESTLIVE_FEATURE_FLAGS;
