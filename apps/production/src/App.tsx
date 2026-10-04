import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { useTranslation } from 'react-i18next';
import { auth } from './firebase';
import { LocalRecoveryView } from './LocalRecoveryView';
import { LiveNodeSetup } from './LiveNodeSetup';
import { liveFeatureFlags } from './featureFlags';
import {
  getScaleOperationalState,
  loadLiveScales,
  loadSharedContext,
  resolveOperationalScale,
  subscribeLiveScales,
  type SharedContext,
  type SharedScale
} from './musicScaleBridge';
import { LiveCueCoordinatorProvider } from './LiveCueCoordinator';
import { detectSameOriginLiveNode } from './liveNodeClient';
import { markLiveMetric } from './telemetry';
import { useLiveNode } from './useLiveNode';
import { useLiveFocus } from './useLiveFocus';
import { useOperatorViewport } from './useOperatorViewport';
import { useLiveSyncSummary } from './useLiveSync';
import { LiveSessionPulse } from './LiveSessionPulse';
import { CloudFleetPulse } from './CloudFleetPulse';
import { TeamChatPanel } from './TeamChatPanel';
import { LiveSceneBar } from './LiveSceneBar';
import { PlaylistSyncAutomation } from './PlaylistSyncAutomation';
import { LiveContextSwitcher } from './LiveContextSwitcher';
import { buildServicePlan, type PreparedSongLink } from './servicePlanBuilder';
import { resolveStudioFlow } from './studioFlow';

const LiveControlPanel = lazy(() =>
  import('./LiveControlPanel').then(module => ({ default: module.LiveControlPanel }))
);
const ScalePreflight = lazy(() =>
  import('./ScalePreflight').then(module => ({ default: module.ScalePreflight }))
);
const SystemTopologyPanel = lazy(() =>
  import('./SystemTopologyPanel').then(module => ({ default: module.SystemTopologyPanel }))
);
const SignalTopologyStudio = lazy(() =>
  import('./SignalTopologyStudio').then(module => ({ default: module.SignalTopologyStudio }))
);
const DiagnosticsPanel = lazy(() =>
  import('./DiagnosticsPanel').then(module => ({ default: module.DiagnosticsPanel }))
);
const PeerNodeStudio = lazy(() =>
  import('./PeerNodeStudio').then(module => ({ default: module.PeerNodeStudio }))
);
const VisualControlPanel = lazy(() =>
  import('./VisualControlPanel').then(module => ({ default: module.VisualControlPanel }))
);
const SyncStatusPanel = lazy(() =>
  import('./SyncStatusPanel').then(module => ({ default: module.SyncStatusPanel }))
);
const RequestSurface = lazy(() =>
  import('./RequestSurface').then(module => ({ default: module.RequestSurface }))
);
const LiveRequestInbox = lazy(() =>
  import('./LiveRequestInbox').then(module => ({ default: module.LiveRequestInbox }))
);
const SceneStudio = lazy(() =>
  import('./SceneStudio').then(module => ({ default: module.SceneStudio }))
);
const LiveDropPanel = lazy(() =>
  import('./LiveDropPanel').then(module => ({ default: module.LiveDropPanel }))
);
const UniversalMediaLibrary = lazy(() =>
  import('./UniversalMediaLibrary').then(module => ({ default: module.UniversalMediaLibrary }))
);
const StudioGuidedHome = lazy(() =>
  import('./StudioGuidedHome').then(module => ({ default: module.StudioGuidedHome }))
);
const ProductionEcosystemPanel = lazy(() =>
  import('./ProductionEcosystemPanel').then(module => ({ default: module.ProductionEcosystemPanel }))
);

const SmartRehearsalPanel = lazy(() =>
  import('./SmartRehearsalPanel').then(module => ({ default: module.SmartRehearsalPanel }))
);

const ServiceReviewPanel = lazy(() =>
  import('./ServiceReviewPanel').then(module => ({ default: module.ServiceReviewPanel }))
);

type Surface = 'live' | 'studio' | 'pastor' | 'conductor';
type LiveSessionMode = 'service' | 'free';
type StudioSection =
  | 'overview'
  | 'prepare'
  | 'library'
  | 'computers'
  | 'routing'
  | 'signal'
  | 'scenes'
  | 'ecosystem'
  | 'diagnostics';

function createEphemeralSessionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') {
    return randomUuid.call(globalThis.crypto);
  }

  const randomValues = globalThis.crypto?.getRandomValues;
  if (typeof randomValues === 'function') {
    const bytes = new Uint8Array(16);
    randomValues.call(globalThis.crypto, bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join('')
    ].join('-');
  }

  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [context, setContext] = useState<SharedContext | null>(null);
  const [scales, setScales] = useState<SharedScale[]>([]);
  const [organizationScope, setOrganizationScope] = useState<'auto' | 'all' | string>('auto');
  const [selectedScaleId, setSelectedScaleId] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const autoCacheSignature = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [localNodeOrigin, setLocalNodeOrigin] = useState(false);
  const [localNodeDetectionDone, setLocalNodeDetectionDone] = useState(false);
  const [surface, setSurface] = useState<Surface>('studio');
  const [studioSection, setStudioSection] = useState<StudioSection>('overview');
  const [showAdvancedStudio, setShowAdvancedStudio] = useState(false);
  const [liveMode, setLiveMode] = useState<LiveSessionMode>('service');
  const [freeSessionId] = useState(createEphemeralSessionId);
  const liveNode = useLiveNode();
  const liveFocus = useLiveFocus(surface === 'live');
  const operatorViewport = useOperatorViewport(surface === 'live');
  const syncSummary = useLiveSyncSummary();

  useEffect(() => {
    let cancelled = false;
    detectSameOriginLiveNode().then(isLocal => {
      if (!cancelled) {
        setLocalNodeOrigin(isLocal);
        setLocalNodeDetectionDone(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    markLiveMetric('shell-mounted');
    return onAuthStateChanged(auth, async currentUser => {
      setUser(currentUser);
      setContext(null);
      setScales([]);
      setOrganizationScope('auto');
      setSelectedScaleId(null);
      setLiveMode('service');
      setStudioSection('overview');
      setShowAdvancedStudio(false);

      if (!currentUser) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const nextContext = await loadSharedContext(currentUser);
        setContext(nextContext);
        if (nextContext) {
          setScales(await loadLiveScales(nextContext.organizations));
        }
      } finally {
        setLoading(false);
        markLiveMetric('shared-context-ready');
      }
    });
  }, []);

  useEffect(() => {
    if (!context?.organizations.length) return;
    return subscribeLiveScales(
      context.organizations,
      nextScales => setScales(nextScales),
      () => undefined
    );
  }, [context?.organizations]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const scopedScales = useMemo(
    () => organizationScope === 'auto' || organizationScope === 'all'
      ? scales
      : scales.filter(item => item.organizationId === organizationScope),
    [organizationScope, scales]
  );

  const selectedScale = useMemo(() => {
    if (!selectedScaleId) return null;
    const candidate = scales.find(item => item.id === selectedScaleId) || null;
    if (!candidate) return null;
    if (
      organizationScope !== 'auto' &&
      organizationScope !== 'all' &&
      candidate.organizationId !== organizationScope
    ) {
      return null;
    }
    return candidate;
  }, [organizationScope, scales, selectedScaleId]);

  const scale = selectedScale || resolveOperationalScale(scopedScales, clockNow);

  const nodeScale = useMemo(() => {
    const organizationId = liveNode.credential?.binding.organizationId;
    if (!organizationId) return null;
    return resolveOperationalScale(
      scales.filter(item => item.organizationId === organizationId),
      clockNow
    );
  }, [clockNow, liveNode.credential?.binding.organizationId, scales]);

  useEffect(() => {
    const binding = liveNode.credential?.binding;
    if (liveNode.state !== 'connected' || !binding || !nodeScale) return;

    const currentPlan = liveNode.nodeState?.state.servicePlan || null;
    const expectedItemIds = nodeScale.songs.map(song => `song:${song.id}`).join('|');
    // Runtime additions made from the Live cockpit use the live-song:* namespace.
    // They must survive the automatic MusicScale -> ServicePlan reconciliation.
    // Only canonical scale items participate in the stale-plan comparison.
    const currentScaleItemIds = currentPlan?.items
      .filter(item => item.id.startsWith('song:'))
      .map(item => item.id)
      .join('|') || '';
    const samePlan =
      currentPlan?.sourceMusicScaleId === nodeScale.id &&
      currentPlan.revision >= Math.max(1, nodeScale.publishRevision || 1) &&
      currentScaleItemIds === expectedItemIds;

    if (samePlan) {
      autoCacheSignature.current = null;
      return;
    }

    const signature = [
      binding.organizationId,
      binding.venueId,
      binding.liveSystemId,
      nodeScale.id,
      nodeScale.publishRevision || 1,
      expectedItemIds
    ].join(':');
    if (autoCacheSignature.current === signature) return;
    autoCacheSignature.current = signature;

    const preparedLinks: PreparedSongLink[] =
      currentPlan?.sourceMusicScaleId === nodeScale.id
        ? (liveNode.nodeState?.state.providerLinks || [])
            .filter(link => Boolean(link.musicScaleEntityId && link.externalId))
            .map(link => ({
              musicScaleSongId: String(link.musicScaleEntityId),
              providerInstanceId: link.providerInstanceId,
              externalId: link.externalId,
              fingerprint: link.fingerprint
            }))
        : [];

    const prepared = buildServicePlan(
      nodeScale,
      {
        venueId: binding.venueId,
        liveSystemId: binding.liveSystemId
      },
      preparedLinks
    );

    void liveNode.cacheServicePlan(prepared.plan, prepared.providerLinks)
      .catch(() => {
        if (autoCacheSignature.current === signature) {
          autoCacheSignature.current = null;
        }
      });
  }, [
    liveNode.credential?.binding.liveSystemId,
    liveNode.credential?.binding.organizationId,
    liveNode.credential?.binding.venueId,
    liveNode.nodeState?.state.providerLinks,
    liveNode.nodeState?.state.servicePlan,
    liveNode.state,
    nodeScale
  ]);

  const nodeStatus = useMemo(() => {
    if (liveNode.state === 'connected') return t('connected');
    if (liveNode.state === 'probing' || liveNode.state === 'pairing') return t('nodeStatus.connecting');
    if (liveNode.state === 'degraded' || liveNode.state === 'reconnecting') return t('nodeStatus.reconnecting');
    if (liveNode.state === 'offline' || liveNode.state === 'blocked') return t('nodeStatus.offline');
    return t('pending');
  }, [liveNode.state, t]);

  const login = () => signInWithPopup(auth, new GoogleAuthProvider());
  const logout = () => signOut(auth);

  if (loading || (!user && !localNodeDetectionDone)) {
    return <main className="center"><div className="boot-orb" /><p>{t('loading')}</p></main>;
  }

  if (!user && localNodeOrigin) {
    return <LocalRecoveryView controller={liveNode} />;
  }

  if (!user) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-kicker">MUSICSCALE / LIVE</div>
          <h1>MusicScale <strong>LIVE</strong></h1>
          <p>{t('sameEcosystem')}</p>
          <button className="primary" onClick={login}>{t('signIn')}</button>
        </section>
      </main>
    );
  }

  const nodeConnected = liveNode.state === 'connected';
  const providersConnected = (liveNode.health?.providersOnline ?? 0) > 0;
  const nodeScopeMatchesScale =
    !scale ||
    !liveNode.credential ||
    liveNode.credential.binding.organizationId === scale.organizationId;
  const nodeOrganization = liveNode.credential
    ? context?.organizations.find(item =>
        item.id === liveNode.credential?.binding.organizationId
      ) || null
    : null;
  const effectiveOrganizationId =
    scale?.organizationId ||
    (
      organizationScope !== 'auto' && organizationScope !== 'all'
        ? organizationScope
        : context?.organizationId
    );
  const effectiveLiveMode: LiveSessionMode =
    liveMode === 'service' && scale ? 'service' : 'free';
  const liveSessionId =
    effectiveLiveMode === 'service' && scale
      ? `music-scale:${scale.id}`
      : `ad-hoc:${context?.organizationId || user.uid}:${freeSessionId}`;

  const hasCachedPlan = Boolean(
    scale &&
    liveNode.nodeState?.state.servicePlan?.sourceMusicScaleId === scale.id
  );

  const studioFlow = resolveStudioFlow({
    nodeConnected,
    providersOnline: liveNode.health?.providersOnline ?? 0,
    hasScale: Boolean(scale),
    scopeMatches: nodeScopeMatchesScale,
    hasCachedPlan
  });

  const primaryStudioSections: Array<{
    key: StudioSection;
    requiresNode?: boolean;
    requiresScale?: boolean;
  }> = [
    { key: 'overview' },
    { key: 'prepare', requiresNode: true },
    { key: 'library', requiresNode: true }
  ];

  const advancedStudioSections: Array<{
    key: StudioSection;
    requiresNode?: boolean;
    requiresScale?: boolean;
  }> = [
    { key: 'computers', requiresNode: true },
    { key: 'routing', requiresNode: true },
    { key: 'signal', requiresNode: true },
    { key: 'scenes', requiresNode: true },
    { key: 'ecosystem', requiresNode: true },
    { key: 'diagnostics', requiresNode: true }
  ];

  const isAdvancedStudioSection = advancedStudioSections.some(
    section => section.key === studioSection
  );
  const advancedStudioVisible = showAdvancedStudio || isAdvancedStudioSection;

  const openStudioSection = (section: StudioSection) => {
    if (advancedStudioSections.some(item => item.key === section)) {
      setShowAdvancedStudio(true);
    }
    setStudioSection(section);
    setSurface('studio');
  };

  const runStudioFlow = () => {
    if (studioFlow.requiresScopeResolution) {
      const organizationId = liveNode.credential?.binding.organizationId;
      if (!organizationId) return;
      setOrganizationScope(organizationId);
      setSelectedScaleId(null);
      setStudioSection('overview');
      return;
    }

    if (studioFlow.destination === 'live') {
      setLiveMode(studioFlow.freeMode ? 'free' : 'service');
      setSurface('live');
      return;
    }

    openStudioSection(studioFlow.destination);
  };

  return (
    <div className={[
      'app-shell',
      surface === 'live' ? 'live-surface' : '',
      liveFocus.fullscreen ? 'live-focus-mode' : '',
      ...operatorViewport.classes
    ].filter(Boolean).join(' ')}>
      <a className="skip-link" href="#main-workspace">
        {t('accessibility.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-kicker">MUSICSCALE / LIVE</div>
          <strong>{t('brand')}</strong>
        </div>
        <div className="top-actions">
          {surface === 'studio' && (
            <button className="top-smart-action" type="button" onClick={runStudioFlow}>
              <small>{t('guidedHome.nextLabel')}</small>
              <strong>{t(`guidedHome.next.${studioFlow.step}Action`)}</strong>
            </button>
          )}
          <div className="top-live-health" aria-label={t('health')}>
            <span className={`top-health-dot ${nodeConnected ? 'ok' : 'warn'}`} />
            <span>{nodeConnected ? t('node') : nodeStatus}</span>
            <b>{liveNode.health?.providersOnline ?? 0}/{liveNode.health?.providers ?? 0}</b>
          </div>
          <select
            value={i18n.resolvedLanguage || 'pt'}
            aria-label={t('accessibility.language')}
            onChange={e => i18n.changeLanguage(e.target.value)}
          >
            <option value="pt">PT</option><option value="en">EN</option><option value="es">ES</option>
          </select>
          <button className="ghost" onClick={logout}>{t('signOut')}</button>
        </div>
      </header>

      <nav className="sidebar" aria-label={t('accessibility.primaryNavigation')}>
        {(['studio','live','pastor','conductor'] as Surface[]).map(item => (
          <button
            key={item}
            onClick={() => setSurface(item)}
            className={surface === item ? 'active' : ''}
            aria-current={surface === item ? 'page' : undefined}
          >
            {t(item)}
          </button>
        ))}
      </nav>

      <main id="main-workspace" className="workspace" tabIndex={-1}>
        <Suspense fallback={
          <section className="surface-loading" role="status" aria-live="polite">
            {t('loading')}
          </section>
        }>
        {context && (
          <LiveContextSwitcher
            context={context}
            scales={scales}
            scope={organizationScope}
            now={clockNow}
            compact={surface !== 'studio'}
            onScopeChange={nextScope => {
              setOrganizationScope(nextScope);
              setSelectedScaleId(null);
            }}
            onOpenScale={nextScale => {
              setOrganizationScope(nextScale.organizationId);
              setSelectedScaleId(nextScale.id);
            }}
          />
        )}

        {surface === 'live' ? (
          <section className="live-session-strip">
            <div className="live-session-identity">
              <span className="live-session-dot" />
              <div>
                <small>{t('liveWorkspace.onAir')}</small>
                <strong>
                  {effectiveLiveMode === 'service'
                    ? scale?.eventName || t('liveWorkspace.preparedService')
                    : t('liveWorkspace.adHoc')}
                </strong>
                <span>
                  {scale?.organizationName || context?.organizationName || t('organization')}
                  {effectiveLiveMode === 'service' && scale?.time ? ` · ${scale.time}` : ''}
                  {effectiveLiveMode === 'service' && scale?.locationName ? ` · ${scale.locationName}` : ''}
                  {effectiveLiveMode === 'free' ? ` · ${t('liveWorkspace.freeModeHint')}` : ''}
                </span>
              </div>
            </div>
            <div className="live-session-mode" role="group" aria-label={t('liveWorkspace.modeLabel')}>
              <button
                type="button"
                className={effectiveLiveMode === 'service' ? 'active' : ''}
                disabled={!scale}
                onClick={() => setLiveMode('service')}
              >
                <small>{t('liveWorkspace.prepared')}</small>
                <strong>{t('liveWorkspace.serviceMode')}</strong>
              </button>
              <button
                type="button"
                className={effectiveLiveMode === 'free' ? 'active' : ''}
                onClick={() => setLiveMode('free')}
              >
                <small>{t('liveWorkspace.noPlan')}</small>
                <strong>{t('liveWorkspace.freeMode')}</strong>
              </button>
            </div>
            <div className="live-session-health">
              <span className={nodeConnected ? 'ok' : 'warn'}>
                <b />{t('node')} · {nodeStatus}
              </span>
              <span className={providersConnected ? 'ok' : 'warn'}>
                <b />{t('providers')} · {providersConnected ? `${liveNode.health?.providersOnline ?? 0}/${liveNode.health?.providers ?? 0}` : t('pending')}
              </span>
              <span className="ok">
                <b />{t('liveWorkspace.lanPath')}
              </span>
              {liveFocus.wakeSupported && (
                <span className={liveFocus.wakeActive ? 'ok' : 'warn'}>
                  <b />{liveFocus.wakeActive
                    ? t('liveWorkspace.screenAwake')
                    : t('liveWorkspace.wakeUnavailable')}
                </span>
              )}
              <button
                className="live-focus-button"
                type="button"
                onClick={() => void liveFocus.toggleFullscreen()}
              >
                {liveFocus.fullscreen
                  ? t('liveWorkspace.exitFullscreen')
                  : t('liveWorkspace.fullscreen')}
              </button>
              <button
                className="operator-exit-button"
                type="button"
                onClick={() => setSurface('studio')}
              >
                {t('liveWorkspace.exitOperator')}
              </button>
            </div>
          </section>
        ) : (
          <>
            {surface === 'studio' && (
              <section className="hero">
                <div>
                  <span className="eyebrow">{t('foundation')} · 0.1.0-alpha.1</span>
                  <h1>Live Studio</h1>
                  <p>{context?.organizationName || t('organization')}</p>
                </div>
                <div className="pill-row">
                  <span>{t('lanFirst')}</span><span>{t('providerAgnostic')}</span><span>{t('offlineReady')}</span>
                </div>
              </section>
            )}

            {surface === 'studio' && studioSection === 'overview' && (
              <section className="health-grid">
                <article>
                  <span className={`status ${syncSummary.overall === 'synced' ? 'ok' : syncSummary.overall === 'failed' || syncSummary.overall === 'conflict' ? 'danger' : 'warn'}`} />
                  <div>
                    <small>{t('cloud')}</small>
                    <strong>{t(`syncState.${syncSummary.overall}`)}</strong>
                  </div>
                </article>
                <article>
                  <span className={`status ${nodeConnected ? 'ok' : liveNode.state === 'offline' || liveNode.state === 'blocked' ? 'danger' : 'warn'}`} />
                  <div><small>{t('node')}</small><strong>{nodeStatus}</strong></div>
                </article>
                <article>
                  <span className={`status ${providersConnected ? 'ok' : 'warn'}`} />
                  <div><small>{t('providers')}</small><strong>{providersConnected ? `${liveNode.health?.providersOnline ?? 0}/${liveNode.health?.providers ?? 0}` : t('pending')}</strong></div>
                </article>
              </section>
            )}

            {surface === 'studio' && studioSection === 'overview' && (
              <SyncStatusPanel />
            )}

            {surface === 'studio' && (
              <nav className="studio-section-nav" aria-label={t('studioNavigation.ariaLabel')}>
                {primaryStudioSections.map(section => {
                  const disabled =
                    (section.requiresNode && !nodeConnected) ||
                    (section.requiresScale && !scale);
                  return (
                    <button
                      key={section.key}
                      type="button"
                      className={studioSection === section.key ? 'active' : ''}
                      disabled={disabled}
                      onClick={() => openStudioSection(section.key)}
                    >
                      <span>{t(`studioNavigation.sections.${section.key}`)}</span>
                      {section.key === 'prepare' && scale && (
                        <em>{scale.songs.length}</em>
                      )}
                    </button>
                  );
                })}
                <span className="studio-nav-divider" aria-hidden="true" />
                <button
                  type="button"
                  className={`studio-system-toggle ${advancedStudioVisible ? 'active' : ''}`}
                  onClick={() => setShowAdvancedStudio(value => !value)}
                  aria-expanded={advancedStudioVisible}
                >
                  <span>{t('studioNavigation.system')}</span>
                  <b className={providersConnected ? 'ok' : 'warn'} />
                </button>
                {advancedStudioVisible && advancedStudioSections.map(section => {
                  const disabled =
                    (section.requiresNode && !nodeConnected) ||
                    (section.requiresScale && !scale);
                  return (
                    <button
                      key={section.key}
                      type="button"
                      className={studioSection === section.key ? 'active' : ''}
                      disabled={disabled}
                      onClick={() => openStudioSection(section.key)}
                    >
                      <span>{t(`studioNavigation.sections.${section.key}`)}</span>
                      {section.key === 'diagnostics' && nodeConnected && (
                        <b className={providersConnected ? 'ok' : 'warn'} />
                      )}
                    </button>
                  );
                })}
              </nav>
            )}
          </>
        )}

        {surface === 'live' && operatorViewport.showLandscapeHint && (
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

        {liveNode.state === 'connected' && (
          <CloudFleetPulse
            controller={liveNode}
            actorId={user.uid}
          />
        )}

        {liveNode.state === 'connected' && scale && nodeScopeMatchesScale && (
          <PlaylistSyncAutomation
            controller={liveNode}
            scale={scale}
            actorId={user.uid}
          />
        )}

        {liveNode.state === 'connected' && scale && !nodeScopeMatchesScale && (
          <section className="live-context-mismatch" role="alert">
            <div>
              <span className="eyebrow">{t('liveContext.nodeScopeKicker')}</span>
              <strong>{t('liveContext.nodeScopeTitle')}</strong>
              <p>{t('liveContext.nodeScopeDescription', {
                node: nodeOrganization?.name || liveNode.credential?.binding.organizationId,
                selected: scale.organizationName || scale.organizationId
              })}</p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setOrganizationScope(liveNode.credential!.binding.organizationId);
                setSelectedScaleId(null);
              }}
            >
              {t('liveContext.useNodeOrganization')}
            </button>
          </section>
        )}

        {surface === 'studio' && studioSection === 'overview' && (
          <StudioGuidedHome
            nodeConnected={nodeConnected}
            providersOnline={liveNode.health?.providersOnline ?? 0}
            providersTotal={liveNode.health?.providers ?? 0}
            hasScale={Boolean(scale)}
            scaleName={scale?.eventName || undefined}
            scaleSongs={scale?.songs.length || 0}
            scopeMatches={nodeScopeMatchesScale}
            hasCachedPlan={hasCachedPlan}
            onOpenSection={openStudioSection}
            onOpenLive={freeMode => {
              setLiveMode(freeMode ? 'free' : 'service');
              setSurface('live');
            }}
            onResolveScope={() => {
              const organizationId = liveNode.credential?.binding.organizationId;
              if (!organizationId) return;
              setOrganizationScope(organizationId);
              setSelectedScaleId(null);
            }}
          />
        )}

        {surface === 'studio' && studioSection === 'overview' && context && liveFeatureFlags.liveNodeTransport && (
          <LiveNodeSetup
            controller={liveNode}
            organizationId={effectiveOrganizationId || context.organizationId}
          />
        )}

        {surface === 'studio' && studioSection === 'overview' && liveNode.state === 'connected' && nodeScopeMatchesScale && liveFeatureFlags.serviceReview && (
          <ServiceReviewPanel
            controller={liveNode}
            liveSessionId={liveSessionId}
          />
        )}

        {surface === 'studio' && studioSection === 'computers' && liveNode.state === 'connected' && (
          <PeerNodeStudio controller={liveNode} />
        )}

        {surface === 'studio' && studioSection === 'routing' && liveNode.state === 'connected' && (
          <SystemTopologyPanel controller={liveNode} />
        )}

        {surface === 'studio' && studioSection === 'signal' && liveNode.state === 'connected' && (
          <SignalTopologyStudio controller={liveNode} />
        )}

        {surface === 'studio' && studioSection === 'ecosystem' && liveNode.state === 'connected' && (
          <ProductionEcosystemPanel
            controller={liveNode}
            actorId={user.uid}
          />
        )}

        {surface === 'studio' && studioSection === 'diagnostics' && liveNode.state === 'connected' && (
          <DiagnosticsPanel controller={liveNode} />
        )}

        {surface === 'studio' && studioSection === 'library' && liveNode.state === 'connected' && (
          <UniversalMediaLibrary
            controller={liveNode}
            actorId={user.uid}
            liveSessionId={liveSessionId}
          />
        )}

        {surface === 'studio' && studioSection === 'prepare' && liveNode.state === 'connected' && (
          <LiveDropPanel
            controller={liveNode}
            actorId={user.uid}
            liveSessionId={liveSessionId}
          />
        )}

        {surface === 'studio' && studioSection === 'prepare' && liveNode.state === 'connected' && scale && nodeScopeMatchesScale && (
          <ScalePreflight
            controller={liveNode}
            scale={scale}
            actorId={user.uid}
            onOpenLive={() => {
              setLiveMode('service');
              setSurface('live');
            }}
          />
        )}

        {surface === 'studio' && studioSection === 'prepare' && liveNode.state === 'connected' && nodeScopeMatchesScale && liveFeatureFlags.smartRehearsal && (
          <SmartRehearsalPanel controller={liveNode} />
        )}

        {surface === 'studio' && studioSection === 'scenes' && liveNode.state === 'connected' && (
          <SceneStudio controller={liveNode} actorId={user.uid} />
        )}

        {surface === 'live' && liveNode.state === 'connected' && nodeScopeMatchesScale && (
          <LiveCueCoordinatorProvider key={liveSessionId}>
            <LiveControlPanel
              controller={liveNode}
              actorId={user.uid}
              liveSessionId={liveSessionId}
              servicePlanEnabled={effectiveLiveMode === 'service'}
              touchPrimary={operatorViewport.touchCapable}
            />
            <LiveSceneBar
              controller={liveNode}
              actorId={user.uid}
              liveSessionId={liveSessionId}
            />
            <VisualControlPanel
              controller={liveNode}
              actorId={user.uid}
              liveSessionId={liveSessionId}
            />
            <LiveRequestInbox
              controller={liveNode}
              actorId={user.uid}
              liveSessionId={liveSessionId}
            />
            <TeamChatPanel
              controller={liveNode}
              actorId={user.uid}
              liveSessionId={liveSessionId}
              senderContext="operator"
            />
            <LiveSessionPulse
              controller={liveNode}
              liveSessionId={liveSessionId}
            />
          </LiveCueCoordinatorProvider>
        )}

        {(surface === 'pastor' || surface === 'conductor') && liveNode.state === 'connected' && nodeScopeMatchesScale && (
          <RequestSurface
            controller={liveNode}
            actorId={user.uid}
            liveSessionId={liveSessionId}
            mode={surface}
          />
        )}

        {(surface === 'pastor' || surface === 'conductor') && (liveNode.state !== 'connected' || !nodeScopeMatchesScale) && (
          <section className="panel request-node-required">
            <strong>{t('requestsSurface.nodeRequiredTitle')}</strong>
            <p>{t('requestsSurface.nodeRequiredDescription')}</p>
          </section>
        )}

        {surface === 'studio' && studioSection === 'overview' && <section className="content-grid">
          <article className="panel next-service">
            <div className="panel-head"><span>{t('nextService')}</span><small>{t('readOnlyBridge')}</small></div>
            {scale ? (
              <>
                <div className="service-title">
                  <div>
                    <strong>{scale.eventName || 'Culto'}</strong>
                    <span>{scale.date}{scale.time ? ` · ${scale.time}` : ''}{scale.locationName ? ` · ${scale.locationName}` : ''}</span>
                  </div>
                  <em>{scale.songs.length} {t('songs')}</em>
                </div>
                <div className="song-list">
                  {scale.songs.map((song, index) => <div key={song.id}><b>{String(index + 1).padStart(2,'0')}</b><span>{song.title}<small>{song.artist || ''}</small></span></div>)}
                </div>
              </>
            ) : <p className="muted">{t('noService')}</p>}
          </article>

          <article className="panel live-preview">
            <div className="preview-screen">
              <span>PROGRAM</span>
              <strong>LIVE GRAPH</strong>
              <small>{surface === 'studio' ? 'Nodes · Providers · Routes · Outputs' : 'Preview / Program / Take'}</small>
            </div>
            <nav className="quick-nav" aria-label={t('guidedHome.previewShortcutsLabel')}>
              <button type="button" onClick={() => setSurface('live')}>{t('now')}</button>
              <button type="button" onClick={() => setSurface('live')}>{t('timeline')}</button>
              <button type="button" onClick={() => setSurface('live')}>{t('bible')}</button>
              <button type="button" onClick={() => openStudioSection('library')}>{t('media')}</button>
              <button type="button" onClick={() => setSurface('live')}>{t('requests')}</button>
            </nav>
          </article>
        </section>}
        </Suspense>
      </main>
    </div>
  );
}
