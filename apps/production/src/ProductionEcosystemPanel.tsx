import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AudioProfile,
  AudioRouteAlias,
  LiveTemplate
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import {
  subscribeCloudFleet,
  type CloudFleetNode
} from './liveCloudRepository';
import {
  activateNodeFailover,
  exportNodeBackup,
  inspectNodeStandbyPeer,
  loadLocalProductionProviderCatalog,
  loadNodeProductionWorkspace,
  loadNodeRedundancyStatus,
  prepareNodeStandbyPeer,
  removeLocalProductionProvider,
  restoreNodeBackup,
  saveLocalProductionProvider,
  saveNodeAudioProfile,
  saveNodeProductionTemplate,
  type LiveNodeBackupBundle,
  type LocalProductionProviderCatalog,
  type ProductionAdapterCatalogItem,
  type ProductionWorkspaceResponse,
  type RedundancyStatusResponse
} from './liveNodeClient';

type Controller = ReturnType<typeof useLiveNode>;

function id(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json'
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function defaultSetupValue(field: ProductionAdapterCatalogItem['setup'][number]) {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.kind === 'boolean') return false;
  return '';
}

export function ProductionEcosystemPanel({
  controller,
  actorId
}: {
  controller: Controller;
  actorId: string;
}) {
  const { t } = useTranslation();
  const credential = controller.credential;
  const [cloudFleet, setCloudFleet] = useState<CloudFleetNode[]>([]);
  const [workspace, setWorkspace] = useState<ProductionWorkspaceResponse>({
    audioProfiles: [],
    templates: []
  });
  const [redundancy, setRedundancy] = useState<RedundancyStatusResponse | null>(null);
  const [catalog, setCatalog] = useState<LocalProductionProviderCatalog | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState('');
  const [adapterInstance, setAdapterInstance] = useState('');
  const [adapterName, setAdapterName] = useState('');
  const [adapterConfig, setAdapterConfig] = useState<Record<string, unknown>>({});
  const [profileName, setProfileName] = useState('');
  const [routeName, setRouteName] = useState('');
  const [routeProviderId, setRouteProviderId] = useState('');
  const [routeExternalId, setRouteExternalId] = useState('');
  const [routeDirection, setRouteDirection] = useState<AudioRouteAlias['direction']>('input');
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failoverConfirm, setFailoverConfirm] = useState<string | null>(null);
  const [peerInspections, setPeerInspections] = useState<Record<string, string>>({});

  const localSetupAvailable = Boolean(
    credential && isLoopback(credential.baseUrl)
  );

  const refresh = useCallback(async () => {
    if (!credential || credential.collaboration) return;
    const [nextWorkspace, nextRedundancy] = await Promise.all([
      loadNodeProductionWorkspace(credential.baseUrl, credential.token),
      loadNodeRedundancyStatus(credential.baseUrl, credential.token)
    ]);
    setWorkspace(nextWorkspace);
    setRedundancy(nextRedundancy);

    if (isLoopback(credential.baseUrl)) {
      setCatalog(
        await loadLocalProductionProviderCatalog(credential.baseUrl)
      );
    } else {
      setCatalog(null);
    }
  }, [credential?.baseUrl, credential?.token, credential?.collaboration]);

  useEffect(() => {
    void refresh().catch(error => {
      setMessage(error instanceof Error ? error.message : 'production_ecosystem_load_failed');
    });
  }, [refresh]);

  useEffect(() => {
    const organizationId = credential?.binding.organizationId;
    if (!organizationId || credential?.collaboration) {
      setCloudFleet([]);
      return;
    }
    return subscribeCloudFleet(
      organizationId,
      nodes => setCloudFleet(nodes),
      () => setCloudFleet([])
    );
  }, [credential?.binding.organizationId, credential?.collaboration]);

  const manifest = useMemo(
    () => catalog?.catalog.find(item => item.adapterKey === selectedAdapter) || null,
    [catalog, selectedAdapter]
  );

  useEffect(() => {
    if (!manifest) {
      setAdapterConfig({});
      return;
    }
    setAdapterInstance(
      manifest.adapterKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-main'
    );
    setAdapterName(manifest.displayName);
    setAdapterConfig(Object.fromEntries(
      manifest.setup.map(field => [field.key, defaultSetupValue(field)])
    ));
  }, [manifest?.adapterKey]);

  async function withBusy(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'production_ecosystem_failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveAdapter() {
    if (!credential || !manifest) return;
    await withBusy('adapter', async () => {
      const result = await saveLocalProductionProvider(credential.baseUrl, {
        instanceId: adapterInstance.trim(),
        adapterKey: manifest.adapterKey,
        displayName: adapterName.trim() || manifest.displayName,
        config: adapterConfig
      });
      setMessage(
        result.probe?.reachable
          ? t('productionEcosystem.adapterSavedOnline')
          : t('productionEcosystem.adapterSavedOffline')
      );
      await refresh();
    });
  }

  async function removeAdapter(instanceId: string) {
    if (!credential) return;
    await withBusy(`adapter-remove:${instanceId}`, async () => {
      await removeLocalProductionProvider(credential.baseUrl, instanceId);
      await refresh();
    });
  }

  async function saveProfile() {
    if (!credential) return;
    const binding = credential.binding;
    const now = new Date().toISOString();
    const routes: AudioRouteAlias[] = [];
    if (routeName.trim() || routeProviderId.trim() || routeExternalId.trim()) {
      routes.push({
        id: id('audio-route'),
        name: routeName.trim(),
        providerId: routeProviderId.trim(),
        externalRouteId: routeExternalId.trim(),
        direction: routeDirection
      });
    }

    const profile: AudioProfile = {
      id: id('audio-profile'),
      organizationId: binding.organizationId,
      venueId: binding.venueId,
      liveSystemId: binding.liveSystemId,
      name: profileName.trim(),
      routes,
      createdAt: now,
      updatedAt: now
    };

    await withBusy('audio-profile', async () => {
      await saveNodeAudioProfile(
        credential.baseUrl,
        credential.token,
        profile
      );
      setProfileName('');
      setRouteName('');
      setRouteProviderId('');
      setRouteExternalId('');
      await refresh();
    });
  }

  async function captureTemplate() {
    if (!credential) return;
    const state = controller.nodeState?.state;
    if (!state) return;

    const template: Partial<LiveTemplate> & {
      id: string;
      name: string;
      kind: LiveTemplate['kind'];
      payload: Record<string, unknown>;
      createdBy: string;
    } = {
      id: id('template'),
      name: templateName.trim(),
      kind: 'full-production',
      createdBy: actorId,
      marketplaceStatus: 'private',
      shared: false,
      payload: {
        servicePlan: state.servicePlan,
        providerLinks: state.providerLinks,
        scenes: state.scenes,
        routing: controller.nodeState?.routing || {},
        signalTopology: controller.nodeState?.signalTopology || null
      }
    };

    await withBusy('template', async () => {
      await saveNodeProductionTemplate(
        credential.baseUrl,
        credential.token,
        template
      );
      setTemplateName('');
      await refresh();
    });
  }

  async function exportBackupFile() {
    if (!credential) return;
    await withBusy('backup-export', async () => {
      const backup = await exportNodeBackup(
        credential.baseUrl,
        credential.token
      );
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`nestlive-backup-${stamp}.json`, backup);
      setMessage(t('productionEcosystem.backupExported'));
    });
  }

  async function restoreBackupFile(event: ChangeEvent<HTMLInputElement>) {
    if (!credential) return;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    await withBusy('backup-restore', async () => {
      const backup = JSON.parse(await file.text()) as LiveNodeBackupBundle;
      await restoreNodeBackup(
        credential.baseUrl,
        credential.token,
        backup
      );
      await controller.refreshState();
      await refresh();
      setMessage(t('productionEcosystem.backupRestored'));
    });
  }

  async function preparePeer(remoteNodeId: string) {
    if (!credential) return;
    await withBusy(`standby:${remoteNodeId}`, async () => {
      await prepareNodeStandbyPeer(
        credential.baseUrl,
        credential.token,
        remoteNodeId
      );
      const inspected = await inspectNodeStandbyPeer(
        credential.baseUrl,
        credential.token,
        remoteNodeId
      );
      setPeerInspections(current => ({
        ...current,
        [remoteNodeId]: inspected.decision.reason
      }));
      setMessage(t('productionEcosystem.standbyPrepared'));
      await refresh();
    });
  }

  async function inspectPeer(remoteNodeId: string) {
    if (!credential) return;
    await withBusy(`inspect:${remoteNodeId}`, async () => {
      const inspected = await inspectNodeStandbyPeer(
        credential.baseUrl,
        credential.token,
        remoteNodeId
      );
      setPeerInspections(current => ({
        ...current,
        [remoteNodeId]: inspected.decision.reason
      }));
    });
  }

  async function activateFailover(previousNodeId: string) {
    if (!credential || !redundancy?.local.servicePlanId || !redundancy.local.servicePlanRevision) {
      return;
    }
    await withBusy(`failover:${previousNodeId}`, async () => {
      await activateNodeFailover(
        credential.baseUrl,
        credential.token,
        {
          servicePlanId: redundancy.local.servicePlanId!,
          servicePlanRevision: redundancy.local.servicePlanRevision!,
          previousNodeId,
          actorId,
          confirmed: true
        }
      );
      setFailoverConfirm(null);
      await controller.refreshState();
      await refresh();
      setMessage(t('productionEcosystem.failoverActivated'));
    });
  }

  if (!credential || credential.collaboration) return null;

  return (
    <section className="production-ecosystem">
      <header className="production-ecosystem-head">
        <div>
          <span className="eyebrow">{t('productionEcosystem.kicker')}</span>
          <h2>{t('productionEcosystem.title')}</h2>
          <p>{t('productionEcosystem.description')}</p>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          {t('productionEcosystem.refresh')}
        </button>
      </header>

      {message && (
        <div className="production-ecosystem-message" role="status">
          {message}
        </div>
      )}

      <div className="production-ecosystem-grid">
        <article className="panel production-integration-card">
          <header>
            <div>
              <small>{t('productionEcosystem.integrationsKicker')}</small>
              <strong>{t('productionEcosystem.integrationsTitle')}</strong>
            </div>
            <span>{catalog?.providers.length || 0}</span>
          </header>

          <div className="production-chip-grid">
            {[
              'OBS',
              'Companion',
              'OSC',
              'MIDI',
              'ATEM',
              'vMix',
              'Art-Net / DMX'
            ].map(name => <span key={name}>{name}</span>)}
          </div>

          {!localSetupAvailable ? (
            <div className="production-safe-note">
              <strong>{t('productionEcosystem.localSetupTitle')}</strong>
              <span>{t('productionEcosystem.localSetupHint')}</span>
            </div>
          ) : (
            <>
              <div className="production-form-grid">
                <label>
                  <span>{t('productionEcosystem.adapterType')}</span>
                  <select
                    value={selectedAdapter}
                    onChange={event => setSelectedAdapter(event.target.value)}
                  >
                    <option value="">{t('productionEcosystem.selectAdapter')}</option>
                    {catalog?.catalog.map(item => (
                      <option key={item.adapterKey} value={item.adapterKey}>
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {manifest && (
                  <>
                    <label>
                      <span>{t('productionEcosystem.instanceId')}</span>
                      <input
                        value={adapterInstance}
                        onChange={event => setAdapterInstance(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>{t('productionEcosystem.displayName')}</span>
                      <input
                        value={adapterName}
                        onChange={event => setAdapterName(event.target.value)}
                      />
                    </label>
                    {manifest.setup.map(field => (
                      <label key={field.key}>
                        <span>{field.label}</span>
                        {field.kind === 'boolean' ? (
                          <select
                            value={String(adapterConfig[field.key] === true)}
                            onChange={event => setAdapterConfig(current => ({
                              ...current,
                              [field.key]: event.target.value === 'true'
                            }))}
                          >
                            <option value="false">{t('productionEcosystem.no')}</option>
                            <option value="true">{t('productionEcosystem.yes')}</option>
                          </select>
                        ) : (
                          <input
                            type={field.secret ? 'password' : field.kind === 'number' || field.kind === 'port' ? 'number' : 'text'}
                            value={String(adapterConfig[field.key] ?? '')}
                            placeholder={field.help || ''}
                            onChange={event => setAdapterConfig(current => ({
                              ...current,
                              [field.key]:
                                field.kind === 'number' || field.kind === 'port'
                                  ? Number(event.target.value)
                                  : event.target.value
                            }))}
                          />
                        )}
                      </label>
                    ))}
                    <button
                      type="button"
                      className="primary"
                      disabled={busy !== null || !adapterInstance.trim()}
                      onClick={() => void saveAdapter()}
                    >
                      {t('productionEcosystem.saveAndTest')}
                    </button>
                  </>
                )}
              </div>

              {catalog?.providers.map(provider => (
                <div className="production-row" key={provider.instanceId}>
                  <div>
                    <strong>{provider.displayName}</strong>
                    <span>{provider.adapterKey} · {provider.instanceId}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy !== null}
                    onClick={() => void removeAdapter(provider.instanceId)}
                  >
                    {t('productionEcosystem.remove')}
                  </button>
                </div>
              ))}
            </>
          )}
        </article>

        <article className="panel">
          <header>
            <div>
              <small>{t('productionEcosystem.audioKicker')}</small>
              <strong>{t('productionEcosystem.audioTitle')}</strong>
            </div>
            <span>{workspace.audioProfiles.length}</span>
          </header>
          <p>{t('productionEcosystem.audioHint')}</p>
          <div className="production-form-grid">
            <label>
              <span>{t('productionEcosystem.profileName')}</span>
              <input
                value={profileName}
                onChange={event => setProfileName(event.target.value)}
              />
            </label>
            <label>
              <span>{t('productionEcosystem.routeHumanName')}</span>
              <input
                value={routeName}
                onChange={event => setRouteName(event.target.value)}
              />
            </label>
            <label>
              <span>{t('productionEcosystem.routeProvider')}</span>
              <input
                value={routeProviderId}
                onChange={event => setRouteProviderId(event.target.value)}
                placeholder="osc-mixer"
              />
            </label>
            <label>
              <span>{t('productionEcosystem.routeExternalId')}</span>
              <input
                value={routeExternalId}
                onChange={event => setRouteExternalId(event.target.value)}
                placeholder="/mix/input/1"
              />
            </label>
            <label>
              <span>{t('productionEcosystem.routeDirection')}</span>
              <select
                value={routeDirection}
                onChange={event => setRouteDirection(event.target.value as AudioRouteAlias['direction'])}
              >
                <option value="input">{t('productionEcosystem.directions.input')}</option>
                <option value="output">{t('productionEcosystem.directions.output')}</option>
                <option value="bus">{t('productionEcosystem.directions.bus')}</option>
                <option value="aux">{t('productionEcosystem.directions.aux')}</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={
                busy !== null ||
                !profileName.trim() ||
                Boolean(routeName.trim() && (!routeProviderId.trim() || !routeExternalId.trim()))
              }
              onClick={() => void saveProfile()}
            >
              {t('productionEcosystem.saveProfile')}
            </button>
          </div>
          {workspace.audioProfiles.map(profile => (
            <div className="production-row" key={profile.id}>
              <div>
                <strong>{profile.name}</strong>
                <span>{profile.routes.length} {t('productionEcosystem.routes')}</span>
              </div>
            </div>
          ))}
        </article>

        <article className="panel">
          <header>
            <div>
              <small>{t('productionEcosystem.templatesKicker')}</small>
              <strong>{t('productionEcosystem.templatesTitle')}</strong>
            </div>
            <span>{workspace.templates.length}</span>
          </header>
          <p>{t('productionEcosystem.templatesHint')}</p>
          <div className="production-inline-form">
            <input
              value={templateName}
              onChange={event => setTemplateName(event.target.value)}
              placeholder={t('productionEcosystem.templateName')}
            />
            <button
              type="button"
              className="secondary"
              disabled={busy !== null || !templateName.trim()}
              onClick={() => void captureTemplate()}
            >
              {t('productionEcosystem.captureTemplate')}
            </button>
          </div>
          {workspace.templates.map(template => (
            <div className="production-row" key={template.id}>
              <div>
                <strong>{template.name}</strong>
                <span>
                  {template.kind} · v{template.version} · {template.marketplaceStatus}
                </span>
              </div>
            </div>
          ))}
        </article>

        <article className="panel">
          <header>
            <div>
              <small>{t('productionEcosystem.backupKicker')}</small>
              <strong>{t('productionEcosystem.backupTitle')}</strong>
            </div>
          </header>
          <p>{t('productionEcosystem.backupHint')}</p>
          <div className="production-backup-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy !== null}
              onClick={() => void exportBackupFile()}
            >
              {t('productionEcosystem.exportBackup')}
            </button>
            <label className="button-like ghost">
              {t('productionEcosystem.restoreBackup')}
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy !== null}
                onChange={event => void restoreBackupFile(event)}
              />
            </label>
          </div>
          <small>{t('productionEcosystem.backupSecretNotice')}</small>
        </article>

        <article className="panel production-fleet-card">
          <header>
            <div>
              <small>{t('productionEcosystem.redundancyKicker')}</small>
              <strong>{t('productionEcosystem.redundancyTitle')}</strong>
            </div>
            <span>{redundancy?.peers.length || 0}</span>
          </header>
          <p>{t('productionEcosystem.redundancyHint')}</p>
          <div className="production-row local-node">
            <div>
              <strong>{redundancy?.local.displayName || t('productionEcosystem.thisNode')}</strong>
              <span>
                {redundancy?.local.servicePlanId || t('productionEcosystem.noPlan')}
                {redundancy?.local.servicePlanRevision
                  ? ` · r${redundancy.local.servicePlanRevision}`
                  : ''}
              </span>
            </div>
            <b>{redundancy?.local.activeLiveSessionId
              ? t('productionEcosystem.live')
              : t('productionEcosystem.ready')}</b>
          </div>

          {redundancy?.peers.map(peer => (
            <div className="production-peer" key={peer.nodeId}>
              <div className="production-row">
                <div>
                  <strong>{peer.displayName}</strong>
                  <span>{peer.nodeId} · {peer.providersOnline}/{peer.providers}</span>
                </div>
                <b className={peer.health}>{peer.health}</b>
              </div>
              <div className="production-peer-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy !== null || !redundancy.local.servicePlanId}
                  onClick={() => void preparePeer(peer.nodeId)}
                >
                  {t('productionEcosystem.prepareStandby')}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null}
                  onClick={() => void inspectPeer(peer.nodeId)}
                >
                  {t('productionEcosystem.verifyStandby')}
                </button>
                {!redundancy.local.activeLiveSessionId &&
                  redundancy.local.servicePlanId &&
                  peer.health === 'offline' && (
                    failoverConfirm === peer.nodeId ? (
                      <button
                        type="button"
                        className="danger"
                        disabled={busy !== null}
                        onClick={() => void activateFailover(peer.nodeId)}
                      >
                        {t('productionEcosystem.confirmFailover')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        onClick={() => setFailoverConfirm(peer.nodeId)}
                      >
                        {t('productionEcosystem.activateFailover')}
                      </button>
                    )
                  )}
              </div>
              {peerInspections[peer.nodeId] && (
                <small className="production-peer-result">
                  {t('productionEcosystem.failoverDecision', {
                    reason: peerInspections[peer.nodeId]
                  })}
                </small>
              )}
            </div>
          ))}
          <small>{t('productionEcosystem.noAutomaticFailover')}</small>

          <div className="production-cloud-fleet">
            <div className="production-section-divider">
              <strong>{t('productionEcosystem.organizationFleet')}</strong>
              <span>{cloudFleet.length}</span>
            </div>
            {cloudFleet.length === 0 ? (
              <small>{t('productionEcosystem.organizationFleetEmpty')}</small>
            ) : cloudFleet.map(node => {
              const ageMs = Date.now() - Date.parse(node.lastSeenAt);
              const stale = !Number.isFinite(ageMs) || ageMs > 90_000;
              return (
                <div className="production-row" key={node.id}>
                  <div>
                    <strong>{node.displayName}</strong>
                    <span>
                      {node.venueId} · {node.liveSystemId} · {node.providersOnline}/{node.providers}
                    </span>
                  </div>
                  <b className={stale ? 'offline' : node.health}>
                    {stale
                      ? t('productionEcosystem.stale')
                      : node.health}
                  </b>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}
