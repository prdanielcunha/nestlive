import { useEffect, useMemo, useState } from 'react';
import type {
  EntitySyncState,
  SyncEntityKind,
  SyncStatus
} from '@millionsnest/nestlive-production-domain';
import { liveFeatureFlags } from './featureFlags';
import { initializeLiveSync, liveSyncEngine } from './liveSync';

export type LiveSyncOverallState =
  | 'disabled'
  | 'local'
  | 'pending'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'failed';

export interface LiveSyncSummary {
  overall: LiveSyncOverallState;
  online: boolean;
  total: number;
  local: number;
  pending: number;
  synced: number;
  offline: number;
  conflict: number;
  failed: number;
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export function useLiveSyncSummary(): LiveSyncSummary {
  const [states, setStates] = useState<EntitySyncState[]>([]);
  const [online, setOnline] = useState(browserOnline);

  useEffect(() => {
    let active = true;

    const refresh = () => {
      void liveSyncEngine.states().then(next => {
        if (active) setStates(next);
      }).catch(() => {
        if (active) setStates([]);
      });
    };

    void initializeLiveSync().then(refresh).catch(refresh);
    const unsubscribe = liveSyncEngine.subscribe(refresh);
    const networkRefresh = () => {
      setOnline(browserOnline());
      refresh();
      if (browserOnline()) void liveSyncEngine.flush();
    };
    window.addEventListener('online', networkRefresh);
    window.addEventListener('offline', networkRefresh);

    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('online', networkRefresh);
      window.removeEventListener('offline', networkRefresh);
    };
  }, []);

  return useMemo(() => {
    const counts: Record<SyncStatus, number> = {
      local: 0,
      pending: 0,
      synced: 0,
      offline: 0,
      conflict: 0,
      failed: 0
    };
    for (const state of states) counts[state.status] += 1;

    let overall: LiveSyncOverallState;
    if (!liveFeatureFlags.servicePlanWrites) overall = 'disabled';
    else if (counts.conflict > 0) overall = 'conflict';
    else if (counts.failed > 0) overall = 'failed';
    else if (!online || counts.offline > 0) overall = 'offline';
    else if (counts.pending > 0) overall = 'pending';
    else if (counts.synced > 0) overall = 'synced';
    else overall = 'local';

    return {
      overall,
      online,
      total: states.length,
      ...counts
    };
  }, [online, states]);
}

export function useEntitySyncState(
  entityKind: SyncEntityKind,
  entityId: string | null | undefined
): EntitySyncState | null {
  const [state, setState] = useState<EntitySyncState | null>(null);

  useEffect(() => {
    if (!entityId) {
      setState(null);
      return;
    }

    let active = true;
    const refresh = () => {
      void liveSyncEngine.state(entityKind, entityId).then(next => {
        if (active) setState(next);
      }).catch(() => {
        if (active) setState(null);
      });
    };

    void initializeLiveSync().then(refresh).catch(refresh);
    const unsubscribe = liveSyncEngine.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [entityId, entityKind]);

  return state;
}
