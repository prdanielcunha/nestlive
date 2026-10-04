import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SignalEndpoint,
  SignalEndpointKind,
  SignalEndpointRole,
  SignalLink,
  SignalTransportKind
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { createClientId } from './clientId';

type Controller = ReturnType<typeof useLiveNode>;

const ENDPOINT_KINDS: SignalEndpointKind[] = [
  'provider',
  'ndi',
  'screen-capture',
  'window-capture',
  'hdmi-capture',
  'spout',
  'syphon',
  'camera',
  'browser',
  'display',
  'projector',
  'led',
  'stream',
  'recording',
  'other'
];

const TRANSPORTS: SignalTransportKind[] = [
  'internal',
  'ndi',
  'screen-capture',
  'window-capture',
  'hdmi',
  'spout',
  'syphon',
  'network',
  'other'
];

function makeId(prefix: string): string {
  return `${prefix}_${createClientId().replace(/-/g, '').slice(0, 16)}`;
}

export function SignalTopologyStudio({
  controller
}: {
  controller: Controller;
}) {
  const { t } = useTranslation();
  const topology = controller.nodeState?.signalTopology;
  const providers = controller.nodeState?.providers || [];
  const peers = controller.nodeState?.peers || [];
  const localNodeId = controller.nodeState?.nodeId || '';

  const [endpoints, setEndpoints] = useState<SignalEndpoint[]>([]);
  const [links, setLinks] = useState<SignalLink[]>([]);
  const [endpointName, setEndpointName] = useState('');
  const [endpointRole, setEndpointRole] = useState<SignalEndpointRole>('source');
  const [endpointKind, setEndpointKind] = useState<SignalEndpointKind>('provider');
  const [endpointNodeId, setEndpointNodeId] = useState('');
  const [endpointProviderId, setEndpointProviderId] = useState('');
  const [linkFrom, setLinkFrom] = useState('');
  const [linkTo, setLinkTo] = useState('');
  const [linkTransport, setLinkTransport] = useState<SignalTransportKind>('internal');
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    setEndpoints(topology?.endpoints || []);
    setLinks(topology?.links || []);
  }, [topology?.revision]);

  const nodeNames = useMemo(() => {
    const values = new Map<string, string>();
    if (localNodeId) {
      values.set(localNodeId, controller.health?.hostname || t('signalTopology.thisComputer'));
    }
    for (const peer of peers) values.set(peer.nodeId, peer.displayName || peer.nodeId);
    return values;
  }, [controller.health?.hostname, localNodeId, peers, t]);

  const providerMap = useMemo(
    () => new Map(providers.map(provider => [provider.providerId, provider])),
    [providers]
  );

  const fromOptions = endpoints.filter(endpoint => endpoint.enabled && endpoint.role !== 'output');
  const toOptions = endpoints.filter(endpoint => endpoint.enabled && endpoint.role !== 'source');

  useEffect(() => {
    if (linkFrom && !fromOptions.some(item => item.id === linkFrom)) setLinkFrom('');
    if (linkTo && !toOptions.some(item => item.id === linkTo)) setLinkTo('');
  }, [endpoints]);

  const commit = async (
    nextEndpoints: SignalEndpoint[],
    nextLinks: SignalLink[]
  ) => {
    if (saving) return false;
    setSaving(true);
    setErrorCode(null);
    try {
      await controller.saveSignalTopology({
        endpoints: nextEndpoints,
        links: nextLinks
      });
      setEndpoints(nextEndpoints);
      setLinks(nextLinks);
      return true;
    } catch (error) {
      setErrorCode(error instanceof Error ? error.message : 'signal_topology_save_failed');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addEndpoint = async () => {
    const name = endpointName.trim();
    if (!name || saving) return;

    const selectedProvider = endpointProviderId
      ? providerMap.get(endpointProviderId)
      : undefined;
    const nodeId =
      endpointNodeId ||
      selectedProvider?.nodeId ||
      undefined;

    const endpoint: SignalEndpoint = {
      id: makeId('endpoint'),
      name,
      role: endpointRole,
      kind: endpointKind,
      nodeId,
      providerId: endpointProviderId || undefined,
      enabled: true
    };

    if (await commit([...endpoints, endpoint], links)) {
      setEndpointName('');
      setEndpointProviderId('');
    }
  };

  const removeEndpoint = async (endpointId: string) => {
    const nextEndpoints = endpoints.filter(item => item.id !== endpointId);
    const nextLinks = links.filter(
      item =>
        item.fromEndpointId !== endpointId &&
        item.toEndpointId !== endpointId
    );
    await commit(nextEndpoints, nextLinks);
  };

  const addLink = async () => {
    if (!linkFrom || !linkTo || linkFrom === linkTo || saving) return;
    const link: SignalLink = {
      id: makeId('link'),
      fromEndpointId: linkFrom,
      toEndpointId: linkTo,
      transport: linkTransport,
      enabled: true
    };
    if (await commit(endpoints, [...links, link])) {
      setLinkFrom('');
      setLinkTo('');
    }
  };

  const removeLink = async (linkId: string) => {
    await commit(endpoints, links.filter(item => item.id !== linkId));
  };

  const endpointById = useMemo(
    () => new Map(endpoints.map(endpoint => [endpoint.id, endpoint])),
    [endpoints]
  );

  const grouped: Record<SignalEndpointRole, SignalEndpoint[]> = {
    source: endpoints.filter(item => item.role === 'source'),
    input: endpoints.filter(item => item.role === 'input'),
    output: endpoints.filter(item => item.role === 'output')
  };

  const suggestedTemplate = useMemo(() => {
    if (endpoints.length > 0 || links.length > 0) return null;

    const holyrics = providers.find(provider => provider.providerKey === 'holyrics');
    const resolume = providers.find(provider => provider.providerKey === 'resolume');
    const propresenter = providers.find(provider => provider.providerKey === 'propresenter');

    if (holyrics && resolume) {
      const sourceId = 'suggested_holyrics_program';
      const inputId = 'suggested_arena_input';
      const outputId = 'suggested_main_led';
      return {
        key: 'holyricsArena',
        endpoints: [
          {
            id: sourceId,
            name: 'Holyrics Program',
            role: 'source',
            kind: 'provider',
            nodeId: holyrics.nodeId || undefined,
            providerId: holyrics.providerId,
            enabled: true
          },
          {
            id: inputId,
            name: 'Arena Presentation Input',
            role: 'input',
            kind: 'ndi',
            nodeId: resolume.nodeId || undefined,
            providerId: resolume.providerId,
            enabled: true
          },
          {
            id: outputId,
            name: 'LED Principal',
            role: 'output',
            kind: 'led',
            nodeId: resolume.nodeId || undefined,
            enabled: true
          }
        ] as SignalEndpoint[],
        links: [
          {
            id: 'suggested_holyrics_to_arena',
            fromEndpointId: sourceId,
            toEndpointId: inputId,
            transport: 'ndi',
            enabled: true
          },
          {
            id: 'suggested_arena_to_led',
            fromEndpointId: inputId,
            toEndpointId: outputId,
            transport: 'internal',
            enabled: true
          }
        ] as SignalLink[]
      };
    }

    const presenter = holyrics || propresenter;
    if (presenter) {
      const sourceId = 'suggested_presentation_program';
      const outputId = 'suggested_main_display';
      return {
        key: presenter.providerKey === 'holyrics' ? 'holyricsDisplay' : 'propresenterDisplay',
        endpoints: [
          {
            id: sourceId,
            name: presenter.displayName || 'Presentation Program',
            role: 'source',
            kind: 'provider',
            nodeId: presenter.nodeId || undefined,
            providerId: presenter.providerId,
            enabled: true
          },
          {
            id: outputId,
            name: 'Telão Principal',
            role: 'output',
            kind: 'display',
            nodeId: presenter.nodeId || undefined,
            enabled: true
          }
        ] as SignalEndpoint[],
        links: [
          {
            id: 'suggested_presentation_to_display',
            fromEndpointId: sourceId,
            toEndpointId: outputId,
            transport: 'internal',
            enabled: true
          }
        ] as SignalLink[]
      };
    }

    return null;
  }, [endpoints.length, links.length, providers]);

  const applySuggestedTemplate = async () => {
    if (!suggestedTemplate || saving) return;
    await commit(suggestedTemplate.endpoints, suggestedTemplate.links);
  };

  return (
    <section className="signal-topology panel">
      <div className="signal-topology-head">
        <div>
          <span className="eyebrow">{t('signalTopology.kicker')}</span>
          <h2>{t('signalTopology.title')}</h2>
          <p>{t('signalTopology.description')}</p>
        </div>
        <div className="signal-topology-summary">
          <span>
            <small>{t('signalTopology.endpoints')}</small>
            <strong>{endpoints.length}</strong>
          </span>
          <span>
            <small>{t('signalTopology.links')}</small>
            <strong>{links.length}</strong>
          </span>
        </div>
      </div>

      <div className="signal-plane-note">
        <strong>{t('signalTopology.controlVsMediaTitle')}</strong>
        <span>{t('signalTopology.controlVsMedia')}</span>
      </div>

      {suggestedTemplate && (
        <div className="signal-suggestion">
          <div>
            <span className="eyebrow">{t('signalTopology.smartSuggestion')}</span>
            <strong>{t(`signalTopology.templates.${suggestedTemplate.key}.title`)}</strong>
            <p>{t(`signalTopology.templates.${suggestedTemplate.key}.description`)}</p>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => void applySuggestedTemplate()}
          >
            {saving ? t('signalTopology.saving') : t('signalTopology.applySuggestion')}
          </button>
        </div>
      )}

      <div className="signal-endpoint-groups">
        {(['source', 'input', 'output'] as SignalEndpointRole[]).map(role => (
          <div key={role} className="signal-endpoint-column">
            <div className="signal-column-title">
              <span>{t(`signalTopology.roles.${role}`)}</span>
              <b>{grouped[role].length}</b>
            </div>
            <div className="signal-endpoint-list">
              {grouped[role].map(endpoint => {
                const provider = endpoint.providerId
                  ? providerMap.get(endpoint.providerId)
                  : undefined;
                return (
                  <article key={endpoint.id} className="signal-endpoint-card">
                    <div>
                      <strong>{endpoint.name}</strong>
                      <small>
                        {t(`signalTopology.kinds.${endpoint.kind}`)}
                        {endpoint.nodeId
                          ? ` · ${nodeNames.get(endpoint.nodeId) || endpoint.nodeId}`
                          : ''}
                      </small>
                    </div>
                    {provider && (
                      <span className="signal-provider-chip">
                        {provider.displayName || provider.providerId}
                      </span>
                    )}
                    <button
                      type="button"
                      className="ghost"
                      disabled={saving}
                      onClick={() => void removeEndpoint(endpoint.id)}
                    >
                      {t('signalTopology.remove')}
                    </button>
                  </article>
                );
              })}
              {!grouped[role].length && (
                <div className="signal-empty">
                  {t(`signalTopology.empty.${role}`)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="signal-add-endpoint">
        <div>
          <strong>{t('signalTopology.addEndpoint')}</strong>
          <p>{t('signalTopology.addEndpointHint')}</p>
        </div>
        <div className="signal-form-grid">
          <input
            value={endpointName}
            onChange={event => setEndpointName(event.target.value)}
            placeholder={t('signalTopology.endpointName')}
            maxLength={96}
          />
          <select
            value={endpointRole}
            onChange={event => setEndpointRole(event.target.value as SignalEndpointRole)}
          >
            {(['source', 'input', 'output'] as SignalEndpointRole[]).map(role => (
              <option key={role} value={role}>
                {t(`signalTopology.roles.${role}`)}
              </option>
            ))}
          </select>
          <select
            value={endpointKind}
            onChange={event => setEndpointKind(event.target.value as SignalEndpointKind)}
          >
            {ENDPOINT_KINDS.map(kind => (
              <option key={kind} value={kind}>
                {t(`signalTopology.kinds.${kind}`)}
              </option>
            ))}
          </select>
          <select
            value={endpointNodeId}
            onChange={event => setEndpointNodeId(event.target.value)}
          >
            <option value="">{t('signalTopology.anyComputer')}</option>
            {localNodeId && (
              <option value={localNodeId}>
                {controller.health?.hostname || t('signalTopology.thisComputer')}
              </option>
            )}
            {peers.map(peer => (
              <option key={peer.nodeId} value={peer.nodeId}>
                {peer.displayName || peer.nodeId}
              </option>
            ))}
          </select>
          <select
            value={endpointProviderId}
            onChange={event => {
              const providerId = event.target.value;
              setEndpointProviderId(providerId);
              const provider = providerMap.get(providerId);
              if (provider?.nodeId) setEndpointNodeId(provider.nodeId);
            }}
          >
            <option value="">{t('signalTopology.noProvider')}</option>
            {providers.map(provider => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.displayName || provider.providerId}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={saving || !endpointName.trim()}
            onClick={() => void addEndpoint()}
          >
            {saving ? t('signalTopology.saving') : t('signalTopology.add')}
          </button>
        </div>
      </div>

      <div className="signal-links">
        <div className="signal-links-head">
          <div>
            <strong>{t('signalTopology.routesTitle')}</strong>
            <p>{t('signalTopology.routesHint')}</p>
          </div>
          <div className="signal-link-form">
            <select
              value={linkFrom}
              onChange={event => setLinkFrom(event.target.value)}
            >
              <option value="">{t('signalTopology.from')}</option>
              {fromOptions.map(endpoint => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
            <span>→</span>
            <select
              value={linkTransport}
              onChange={event => setLinkTransport(event.target.value as SignalTransportKind)}
            >
              {TRANSPORTS.map(transport => (
                <option key={transport} value={transport}>
                  {t(`signalTopology.transports.${transport}`)}
                </option>
              ))}
            </select>
            <span>→</span>
            <select
              value={linkTo}
              onChange={event => setLinkTo(event.target.value)}
            >
              <option value="">{t('signalTopology.to')}</option>
              {toOptions.map(endpoint => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="primary"
              disabled={saving || !linkFrom || !linkTo || linkFrom === linkTo}
              onClick={() => void addLink()}
            >
              {t('signalTopology.connect')}
            </button>
          </div>
        </div>

        <div className="signal-link-list">
          {links.map(link => {
            const from = endpointById.get(link.fromEndpointId);
            const to = endpointById.get(link.toEndpointId);
            return (
              <article key={link.id} className="signal-link-card">
                <strong>{from?.name || link.fromEndpointId}</strong>
                <div>
                  <span />
                  <b>{t(`signalTopology.transports.${link.transport}`)}</b>
                  <span />
                </div>
                <strong>{to?.name || link.toEndpointId}</strong>
                <button
                  type="button"
                  className="ghost"
                  disabled={saving}
                  onClick={() => void removeLink(link.id)}
                >
                  {t('signalTopology.remove')}
                </button>
              </article>
            );
          })}
          {!links.length && (
            <div className="signal-empty wide">{t('signalTopology.noRoutes')}</div>
          )}
        </div>
      </div>

      {errorCode && (
        <div className="signal-topology-error">
          {t(`nodeErrors.${errorCode}`, { defaultValue: errorCode })}
        </div>
      )}
    </section>
  );
}
