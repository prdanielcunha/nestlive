import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LiveControlPanel } from './LiveControlPanel';
import { LiveNodeSetup } from './LiveNodeSetup';
import { OfflineRunOfShow } from './OfflineRunOfShow';
import { VisualControlPanel } from './VisualControlPanel';
import { LiveCueCoordinatorProvider } from './LiveCueCoordinator';
import type { useLiveNode } from './useLiveNode';
import { useLiveFocus } from './useLiveFocus';
import { useOperatorViewport } from './useOperatorViewport';
import { createClientId } from './clientId';

type Controller = ReturnType<typeof useLiveNode>;

export function LocalRecoveryView({
  controller
}: {
  controller: Controller;
}) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<'service' | 'free'>('service');
  const [freeSessionId] = useState(() => createClientId());
  const connected = controller.state === 'connected' && Boolean(controller.credential);
  const liveFocus = useLiveFocus(connected);
  const operatorViewport = useOperatorViewport(connected);
  const plan = controller.nodeState?.state.servicePlan || null;
  const providerLinks = controller.nodeState?.state.providerLinks || [];
  const actorId = controller.credential
    ? `local-device:${controller.credential.binding.deviceId}`
    : 'local-device:unpaired';
  const effectiveMode = mode === 'service' && plan ? 'service' : 'free';
  const liveSessionId = effectiveMode === 'service' && plan
    ? `service-plan:${plan.id}`
    : `local-free:${controller.credential?.binding.liveSystemId || 'unpaired'}:${freeSessionId}`;

  return (
    <div className={[
      'local-recovery-shell',
      liveFocus.fullscreen ? 'local-focus-mode' : '',
      ...operatorViewport.classes
    ].filter(Boolean).join(' ')}>
      <header className="local-recovery-topbar">
        <div>
          <div className="brand-kicker">MUSICSCALE / LIVE</div>
          <strong>{t('localRecovery.mode')}</strong>
        </div>
        <div className="local-recovery-actions">
          {connected && (
            <button
              className="live-focus-button"
              type="button"
              onClick={() => void liveFocus.toggleFullscreen()}
            >
              {liveFocus.fullscreen
                ? t('liveWorkspace.exitFullscreen')
                : t('liveWorkspace.fullscreen')}
            </button>
          )}
          <select
            value={i18n.resolvedLanguage || 'pt'}
            onChange={event => i18n.changeLanguage(event.target.value)}
          >
            <option value="pt">PT</option>
            <option value="en">EN</option>
            <option value="es">ES</option>
          </select>
        </div>
      </header>

      <main className="local-recovery-workspace">
        <section className="local-recovery-hero">
          <div>
            <span className="eyebrow">{t('localRecovery.kicker')}</span>
            <h1>{t('localRecovery.title')}</h1>
            <p>{t('localRecovery.description')}</p>
          </div>
          <div className="offline-badge">{t('localRecovery.noCloudRequired')}</div>
        </section>

        <LiveNodeSetup
          controller={controller}
          localRecovery
        />

        {connected && (
          <>
            {operatorViewport.showLandscapeHint && (
              <section className="operator-rotate-hint" role="status">
                <div className="operator-rotate-mark" aria-hidden="true">↻</div>
                <div>
                  <strong>{t('liveWorkspace.rotateTitle')}</strong>
                  <span>{t('liveWorkspace.rotateHint')}</span>
                </div>
                <button type="button" onClick={operatorViewport.dismissLandscapeHint}>
                  {t('liveWorkspace.gotIt')}
                </button>
              </section>
            )}
            <section className="health-grid local-health-grid">
              <article>
                <span className="status ok" />
                <div>
                  <small>{t('node')}</small>
                  <strong>{t('connected')}</strong>
                </div>
              </article>
              <article>
                <span className={`status ${(controller.health?.providersOnline ?? 0) > 0 ? 'ok' : 'warn'}`} />
                <div>
                  <small>{t('providers')}</small>
                  <strong>{controller.health ? `${controller.health.providersOnline}/${controller.health.providers}` : '0/0'}</strong>
                </div>
              </article>
              <article>
                <span className={`status ${plan ? 'ok' : 'warn'}`} />
                <div>
                  <small>{t('localRecovery.plan')}</small>
                  <strong>{plan ? t('localRecovery.cached') : t('pending')}</strong>
                </div>
              </article>
            </section>

            <section className="local-recovery-mode-card">
              <div>
                <span className="eyebrow">{t('localRecovery.operationMode')}</span>
                <strong>
                  {effectiveMode === 'service'
                    ? t('liveWorkspace.serviceMode')
                    : t('liveWorkspace.freeMode')}
                </strong>
                <p>
                  {effectiveMode === 'service'
                    ? t('localRecovery.preparedModeDescription')
                    : t('localRecovery.freeModeDescription')}
                </p>
              </div>
              <div className="live-session-mode" role="group" aria-label={t('liveWorkspace.modeLabel')}>
                <button
                  type="button"
                  className={effectiveMode === 'service' ? 'active' : ''}
                  disabled={!plan}
                  onClick={() => setMode('service')}
                >
                  <small>{t('liveWorkspace.prepared')}</small>
                  <strong>{t('liveWorkspace.serviceMode')}</strong>
                </button>
                <button
                  type="button"
                  className={effectiveMode === 'free' ? 'active' : ''}
                  onClick={() => setMode('free')}
                >
                  <small>{t('liveWorkspace.noPlan')}</small>
                  <strong>{t('liveWorkspace.freeMode')}</strong>
                </button>
              </div>
            </section>

            {effectiveMode === 'service' && plan ? (
              <OfflineRunOfShow
                controller={controller}
                plan={plan}
                providerLinks={providerLinks}
                actorId={actorId}
                liveSessionId={liveSessionId}
              />
            ) : (
              <section className="local-empty local-free-ready">
                <span className="eyebrow">{t('liveWorkspace.freeMode')}</span>
                <h2>{t('localRecovery.freeReadyTitle')}</h2>
                <p>
                  {plan
                    ? t('localRecovery.freeReadyDescription')
                    : t('localRecovery.freeNoPlanDescription')}
                </p>
              </section>
            )}

            <LiveCueCoordinatorProvider key={liveSessionId}>
              <LiveControlPanel
                controller={controller}
                actorId={actorId}
                liveSessionId={liveSessionId}
                servicePlanEnabled={effectiveMode === 'service'}
                touchPrimary={operatorViewport.touchCapable}
              />
              <VisualControlPanel
                controller={controller}
                actorId={actorId}
                liveSessionId={liveSessionId}
              />
            </LiveCueCoordinatorProvider>
          </>
        )}
      </main>
    </div>
  );
}
