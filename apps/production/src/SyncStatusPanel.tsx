import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EntitySyncState,
  SyncConflict
} from '@millionsnest/nestlive-production-domain';
import { liveFeatureFlags } from './featureFlags';
import { initializeLiveSync, liveSyncEngine } from './liveSync';
import { useLiveSyncSummary } from './useLiveSync';

interface ConflictByKey {
  [key: string]: SyncConflict | null;
}

export function SyncStatusPanel() {
  const { t } = useTranslation();
  const summary = useLiveSyncSummary();
  const [states, setStates] = useState<EntitySyncState[]>([]);
  const [conflicts, setConflicts] = useState<ConflictByKey>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const refresh = () => {
      void (async () => {
        await initializeLiveSync();
        const next = await liveSyncEngine.states();
        const nextConflicts: ConflictByKey = {};
        for (const state of next) {
          if (state.status === 'conflict') {
            nextConflicts[state.key] = await liveSyncEngine.conflict(
              state.entityKind,
              state.entityId
            );
          }
        }
        if (active) {
          setStates(next);
          setConflicts(nextConflicts);
        }
      })().catch(() => undefined);
    };

    refresh();
    const unsubscribe = liveSyncEngine.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (!liveFeatureFlags.servicePlanWrites && states.length === 0) {
    return (
      <section className="sync-status-panel state-local">
        <header>
          <div>
            <span className="eyebrow">{t('syncPanel.kicker')}</span>
            <h2>{t('syncPanel.title')}</h2>
          </div>
          <strong>{t('syncState.disabled')}</strong>
        </header>
        <p>{t('syncPanel.localOnly')}</p>
      </section>
    );
  }

  const actionable = states
    .filter(state => ['pending', 'offline', 'conflict', 'failed'].includes(state.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12);

  async function resolve(
    state: EntitySyncState,
    resolution: 'keep-local' | 'use-remote'
  ) {
    setBusyKey(state.key);
    try {
      await liveSyncEngine.resolveConflict(
        state.entityKind,
        state.entityId,
        resolution
      );
      if (resolution === 'keep-local') await liveSyncEngine.flush();
    } finally {
      setBusyKey(null);
    }
  }

  async function retry(state: EntitySyncState) {
    setBusyKey(state.key);
    try {
      await liveSyncEngine.retry(state.entityKind, state.entityId);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className={`sync-status-panel state-${summary.overall}`}>
      <header>
        <div>
          <span className="eyebrow">{t('syncPanel.kicker')}</span>
          <h2>{t('syncPanel.title')}</h2>
          <p>{t('syncPanel.description')}</p>
        </div>
        <div className="sync-status-summary">
          <strong>{t(`syncState.${summary.overall}`)}</strong>
          <small>
            {t('syncPanel.summary', {
              pending: summary.pending + summary.offline,
              conflicts: summary.conflict,
              failed: summary.failed
            })}
          </small>
        </div>
      </header>

      {actionable.length === 0 ? (
        <div className="sync-status-empty">
          <strong>{t('syncPanel.noAction')}</strong>
          <span>{t('syncPanel.noActionHint')}</span>
        </div>
      ) : (
        <div className="sync-status-list">
          {actionable.map(state => {
            const conflict = conflicts[state.key];
            return (
              <article key={state.key} className={`sync-status-item state-${state.status}`}>
                <div>
                  <small>{t(`syncState.${state.status}`)}</small>
                  <strong>{state.entityKind} · {state.entityId}</strong>
                  {state.errorCode && <span>{state.errorCode}</span>}
                  {conflict?.remoteVersion && (
                    <span>
                      {t('syncPanel.remoteVersion')}: {conflict.remoteVersion}
                    </span>
                  )}
                </div>
                <div className="sync-status-actions">
                  {state.status === 'conflict' && (
                    <>
                      <button
                        className="secondary"
                        disabled={busyKey === state.key}
                        onClick={() => void resolve(state, 'use-remote')}
                      >
                        {t('syncPanel.useRemote')}
                      </button>
                      <button
                        className="primary"
                        disabled={busyKey === state.key}
                        onClick={() => void resolve(state, 'keep-local')}
                      >
                        {t('syncPanel.keepLocal')}
                      </button>
                    </>
                  )}
                  {state.status === 'failed' && (
                    <button
                      className="secondary"
                      disabled={busyKey === state.key}
                      onClick={() => void retry(state)}
                    >
                      {t('syncPanel.retry')}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
