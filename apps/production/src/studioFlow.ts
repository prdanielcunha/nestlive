export type StudioFlowStep =
  | 'connectNode'
  | 'providers'
  | 'scope'
  | 'prepare'
  | 'live'
  | 'free';

export interface StudioFlowInput {
  nodeConnected: boolean;
  providersOnline: number;
  hasScale: boolean;
  scopeMatches: boolean;
  hasCachedPlan: boolean;
}

export interface StudioFlowResolution {
  step: StudioFlowStep;
  destination: 'overview' | 'diagnostics' | 'prepare' | 'live';
  freeMode?: boolean;
  requiresScopeResolution?: boolean;
  advanced?: boolean;
}

export function resolveStudioFlow(input: StudioFlowInput): StudioFlowResolution {
  if (!input.nodeConnected) {
    return { step: 'connectNode', destination: 'overview' };
  }

  if (input.providersOnline < 1) {
    return { step: 'providers', destination: 'diagnostics', advanced: true };
  }

  if (input.hasScale && !input.scopeMatches) {
    return {
      step: 'scope',
      destination: 'overview',
      requiresScopeResolution: true
    };
  }

  if (input.hasScale && !input.hasCachedPlan) {
    return { step: 'prepare', destination: 'prepare' };
  }

  if (input.hasScale) {
    return { step: 'live', destination: 'live', freeMode: false };
  }

  return { step: 'free', destination: 'live', freeMode: true };
}
