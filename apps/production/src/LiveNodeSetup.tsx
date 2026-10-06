import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { useLiveNode } from './useLiveNode';

type LiveNodeController = ReturnType<typeof useLiveNode>;

export function LiveNodeSetup({
  controller,
  organizationId,
  localRecovery = false
}: {
  controller: LiveNodeController;
  organizationId?: string;
  localRecovery?: boolean;
}) {
  const { t } = useTranslation();
  const sameOriginNode =
    localRecovery || window.location.port === '4317'
      ? window.location.origin
      : 'http://127.0.0.1:4317';
  const [nodeUrl, setNodeUrl] = useState(
    controller.credential?.baseUrl || sameOriginNode
  );
  const [pin, setPin] = useState('');
  const [connectionTest, setConnectionTest] = useState<
    | { state: 'idle' | 'running' }
    | { state: 'passed'; latencyMs: number; providersOnline: number }
    | { state: 'failed'; code: string }
  >({ state: 'idle' });
  const tutorialStorageKey = 'nestlive:onboarding-tutorial:v1';
  const [tutorialStep, setTutorialStep] = useState(() => {
    try {
      return window.localStorage.getItem(tutorialStorageKey) === 'done' ? 4 : 0;
    } catch {
      return 0;
    }
  });

  const scope = useMemo(() => {
    if (!organizationId) return undefined;
    return {
      organizationId,
      venueId: `bootstrap-venue:${organizationId}`,
      liveSystemId: `bootstrap-system:${organizationId}`
    };
  }, [organizationId]);

  const connected = controller.state === 'connected';
  const tryingLocal =
    controller.state === 'probing' &&
    nodeUrl === sameOriginNode;

  const beginLocal = () => {
    setNodeUrl(sameOriginNode);
    return controller.beginPairing(sameOriginNode, scope);
  };

  const runConnectionTest = async () => {
    setConnectionTest({ state: 'running' });
    try {
      const result = await controller.testConnection();
      setConnectionTest({
        state: 'passed',
        latencyMs: result.latencyMs,
        providersOnline: result.providersOnline
      });
    } catch (error) {
      setConnectionTest({
        state: 'failed',
        code: error instanceof Error ? error.message : 'node_unreachable'
      });
    }
  };

  const finishTutorial = () => {
    try {
      window.localStorage.setItem(tutorialStorageKey, 'done');
    } catch {
      // Tutorial completion is convenience state only.
    }
    setTutorialStep(4);
  };

  return (
    <section className="node-setup premium-system-card">
      <div className="node-setup-copy">
        <span className="eyebrow">{t('nodeSetup.kicker')}</span>
        <h2>{localRecovery ? t('nodeSetup.localRecoveryTitle') : t('nodeSetup.title')}</h2>
        <p>{localRecovery ? t('nodeSetup.localRecoveryDescription') : t('nodeSetup.description')}</p>
      </div>

      <div className="node-setup-card">
        {connected && controller.credential ? (
          <>
            <div className="node-connected-row premium-ready-row">
              <span className="status ok" />
              <div>
                <small>{t('nodeSetup.readyLabel')}</small>
                <strong>{controller.health?.displayName || controller.health?.hostname || t('nodeSetup.connected')}</strong>
                <span>{t('nodeSetup.readyDescription')}</span>
              </div>
              <button className="secondary" onClick={controller.disconnect}>
                {t('nodeSetup.disconnect')}
              </button>
            </div>

            <div className="node-safe-test">
              <div>
                <small>{t('nodeSetup.safeTestKicker')}</small>
                <strong>{t('nodeSetup.safeTestTitle')}</strong>
                <span>{t('nodeSetup.safeTestDescription')}</span>
              </div>
              <button
                className="secondary"
                disabled={connectionTest.state === 'running'}
                onClick={() => void runConnectionTest()}
              >
                {connectionTest.state === 'running'
                  ? t('nodeSetup.safeTestRunning')
                  : t('nodeSetup.safeTestAction')}
              </button>
              {connectionTest.state === 'passed' && (
                <p className="node-test-result ok">
                  {t('nodeSetup.safeTestPassed', {
                    latency: connectionTest.latencyMs,
                    providers: connectionTest.providersOnline
                  })}
                </p>
              )}
              {connectionTest.state === 'failed' && (
                <p className="node-test-result warn">
                  {t('nodeSetup.safeTestFailed', {
                    reason: t(`nodeErrors.${connectionTest.code}`, {
                      defaultValue: connectionTest.code
                    })
                  })}
                </p>
              )}
            </div>

            {tutorialStep < 4 && (
              <div className="node-tutorial">
                <div className="node-tutorial-progress">
                  <small>{t('nodeSetup.tutorialKicker')}</small>
                  <strong>{t('nodeSetup.tutorialTitle')}</strong>
                  <span>{t('nodeSetup.tutorialTime')}</span>
                </div>
                <div className="node-tutorial-step">
                  <b>{String(tutorialStep + 1).padStart(2, '0')}</b>
                  <div>
                    <strong>{t(`nodeSetup.tutorialSteps.${tutorialStep}.title`)}</strong>
                    <p>{t(`nodeSetup.tutorialSteps.${tutorialStep}.description`)}</p>
                  </div>
                </div>
                <div className="node-tutorial-actions">
                  {tutorialStep > 0 && (
                    <button
                      className="secondary"
                      onClick={() => setTutorialStep(step => Math.max(0, step - 1))}
                    >
                      {t('nodeSetup.tutorialBack')}
                    </button>
                  )}
                  {tutorialStep < 3 ? (
                    <button
                      className="primary"
                      onClick={() => setTutorialStep(step => Math.min(3, step + 1))}
                    >
                      {t('nodeSetup.tutorialNext')}
                    </button>
                  ) : (
                    <button className="primary" onClick={finishTutorial}>
                      {t('nodeSetup.tutorialDone')}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="node-meta-grid human-meta-grid">
              <div>
                <small>{t('nodeSetup.providers')}</small>
                <strong>{controller.health ? `${controller.health.providersOnline}/${controller.health.providers}` : '0/0'}</strong>
                <span>{t('nodeSetup.providerStatusHint')}</span>
              </div>
              <div>
                <small>{t('nodeSetup.connection')}</small>
                <strong>{controller.credential.transportKind === 'local-console'
                  ? t('nodeSetup.localConsole')
                  : t('nodeSetup.localNetwork')}</strong>
                <span>{t('nodeSetup.internetNotRequired')}</span>
              </div>
              <div>
                <small>{t('nodeSetup.offline')}</small>
                <strong>{t('nodeSetup.offlineReady')}</strong>
                <span>{t('nodeSetup.offlineHint')}</span>
              </div>
            </div>

            <details className="node-advanced">
              <summary>{t('nodeSetup.technicalDetails')}</summary>
              <div className="node-technical-grid">
                <div><small>{t('nodeSetup.address')}</small><code>{controller.credential.baseUrl}</code></div>
                <div><small>{t('nodeSetup.nodeId')}</small><code>{controller.health?.nodeId || '—'}</code></div>
                <div><small>{t('nodeSetup.version')}</small><code>{controller.health?.version || '—'}</code></div>
              </div>
            </details>
          </>
        ) : controller.pending ? (
          <>
            <div className="pairing-head premium-pairing-head">
              <div>
                <small>{t('nodeSetup.pairing')}</small>
                <strong>{t('nodeSetup.enterPin')}</strong>
              </div>
              <span className="pairing-secure-badge">{t('nodeSetup.localOnly')}</span>
            </div>
            <p className="node-hint">{t('nodeSetup.pinHint')}</p>
            <div className="pairing-form">
              <input
                className="pin-input"
                value={pin}
                onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="••••••"
                aria-label={t('nodeSetup.pin')}
              />
              <button
                className="primary"
                disabled={pin.length !== 6}
                onClick={() => controller.finishPairing(pin)}
              >
                {t('nodeSetup.confirm')}
              </button>
            </div>
            {controller.errorCode && (
              <p className="node-error">{t(`nodeErrors.${controller.errorCode}`, { defaultValue: controller.errorCode })}</p>
            )}
          </>
        ) : (
          <>
            <div className="zero-config-setup">
              <div className="network-requirement">
                <span className="network-requirement-mark" aria-hidden="true" />
                <div>
                  <strong>{t('nodeSetup.sameNetworkTitle')}</strong>
                  <p>{t('nodeSetup.sameNetworkDescription')}</p>
                </div>
                <span className="network-requirement-badge">{t('nodeSetup.noInternet')}</span>
              </div>

              <div className="zero-config-options">
                <article className="zero-config-option primary-path">
                  <div className="zero-config-step">01</div>
                  <div>
                    <small>{t('nodeSetup.sameComputerKicker')}</small>
                    <strong>{t('nodeSetup.sameComputerTitle')}</strong>
                    <p>{t('nodeSetup.sameComputerDescription')}</p>
                  </div>
                  <button
                    className="primary"
                    disabled={controller.state === 'probing'}
                    onClick={() => void beginLocal()}
                  >
                    {tryingLocal ? t('nodeSetup.probing') : t('nodeSetup.findThisComputer')}
                  </button>
                </article>

                <article className="zero-config-option">
                  <div className="zero-config-step">02</div>
                  <div>
                    <small>{t('nodeSetup.tabletKicker')}</small>
                    <strong>{t('nodeSetup.tabletTitle')}</strong>
                    <p>{t('nodeSetup.tabletDescription')}</p>
                  </div>
                  <span className="zero-config-passive-action">{t('nodeSetup.scanQr')}</span>
                </article>
              </div>

              {controller.errorCode && (
                <div className="node-error node-error-friendly">
                  <strong>{t('nodeSetup.notFoundTitle')}</strong>
                  <p>{t(`nodeErrors.${controller.errorCode}`, { defaultValue: controller.errorCode })}</p>
                  <span>
                    {['node_timeout', 'node_unreachable'].includes(controller.errorCode)
                      ? t('nodeSetup.networkIsolationHint')
                      : t('nodeSetup.notFoundHint')}
                  </span>
                </div>
              )}

              <details className="node-advanced">
                <summary>{t('nodeSetup.advanced')}</summary>
                <div className="advanced-connect">
                  <label className="node-field">
                    <span>{t('nodeSetup.nodeAddress')}</span>
                    <input
                      value={nodeUrl}
                      onChange={event => setNodeUrl(event.target.value)}
                      placeholder="192.168.1.20:4317"
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                  </label>
                  <p className="node-hint">{t('nodeSetup.addressHint')}</p>
                  <div className="node-actions">
                    <button
                      className="secondary"
                      disabled={controller.state === 'probing'}
                      onClick={() => controller.beginPairing(nodeUrl, scope)}
                    >
                      {controller.state === 'probing' ? t('nodeSetup.probing') : t('nodeSetup.pair')}
                    </button>
                    <span>{t('nodeSetup.noCloudSecret')}</span>
                  </div>
                </div>
              </details>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
