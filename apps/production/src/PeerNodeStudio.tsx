import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

export function PeerNodeStudio({
  controller
}: {
  controller: Controller;
}) {
  const { t } = useTranslation();
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState('');
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);

  const peers = controller.nodeState?.peers || [];
  const providers = controller.nodeState?.providers || [];
  const localNodeId = controller.nodeState?.nodeId || '';

  useEffect(() => {
    void controller.refreshNearbyNodes();
    const timer = window.setInterval(() => {
      void controller.refreshNearbyNodes();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [controller.credential?.baseUrl]);

  const providersByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const provider of providers) {
      if (!provider.nodeId) continue;
      counts.set(provider.nodeId, (counts.get(provider.nodeId) || 0) + 1);
    }
    return counts;
  }, [providers]);

  const pairedNodeIds = useMemo(
    () => new Set(peers.map(peer => peer.nodeId)),
    [peers]
  );

  const nearby = useMemo(
    () => controller.nearbyNodes.filter(node =>
      node.nodeId !== localNodeId && !pairedNodeIds.has(node.nodeId)
    ),
    [controller.nearbyNodes, localNodeId, pairedNodeIds]
  );

  const startPairing = async (baseUrl: string, nodeId: string) => {
    if (!baseUrl.trim() || busyNodeId) return;
    setBusyNodeId(nodeId);
    try {
      const challenge = await controller.beginPeerPairing(baseUrl.trim());
      if (challenge) setPin('');
    } finally {
      setBusyNodeId(null);
    }
  };

  const completePairing = async () => {
    if (!controller.pendingPeer || pin.replace(/\D/g, '').length !== 6 || busyNodeId) return;
    setBusyNodeId(controller.pendingPeer.remoteNodeId);
    try {
      const ok = await controller.finishPeerPairing(pin);
      if (ok) {
        setAddress('');
        setPin('');
        await controller.refreshNearbyNodes();
      }
    } finally {
      setBusyNodeId(null);
    }
  };

  const manualPair = async () => {
    if (!address.trim()) return;
    await startPairing(address.trim(), 'manual');
  };

  return (
    <section className="peer-node-studio panel premium-system-card">
      <div className="peer-node-head">
        <div>
          <span className="eyebrow">{t('peerNodes.kicker')}</span>
          <h2>{t('peerNodes.title')}</h2>
          <p>{t('peerNodes.description')}</p>
        </div>
        <div className="peer-node-summary">
          <small>{t('peerNodes.computers')}</small>
          <strong>{1 + peers.length}</strong>
          <span>{t('peerNodes.onlineEnvironment')}</span>
        </div>
      </div>

      <div className="network-requirement">
        <span className="network-requirement-mark" aria-hidden="true" />
        <div>
          <strong>{t('peerNodes.sameNetworkTitle')}</strong>
          <p>{t('peerNodes.sameNetworkHint')}</p>
        </div>
        <span className="network-requirement-badge">{t('peerNodes.internetOptional')}</span>
      </div>

      <div className="peer-node-grid">
        <article className="peer-node-card local">
          <div className="peer-node-card-head">
            <span className="status-dot" />
            <div>
              <strong>{controller.health?.hostname || t('peerNodes.thisComputer')}</strong>
              <small>{t('peerNodes.primaryNode')}</small>
            </div>
          </div>
          <div className="peer-node-card-meta">
            <span>{t('peerNodes.online')}</span>
            <span>{providersByNode.get(localNodeId) || 0} {t('peerNodes.providers')}</span>
          </div>
        </article>

        {peers.map(peer => (
          <article key={peer.nodeId} className={`peer-node-card ${peer.health}`}>
            <div className="peer-node-card-head">
              <span className="status-dot" />
              <div>
                <strong>{peer.displayName || peer.nodeId}</strong>
                <small>{peer.health === 'online'
                  ? t('peerNodes.online')
                  : peer.health === 'degraded'
                    ? t('peerNodes.degraded')
                    : t('peerNodes.offline')}</small>
              </div>
            </div>
            <div className="peer-node-card-meta">
              <span>{peer.providersOnline}/{peer.providers} {t('peerNodes.providers')}</span>
              <span>{t('peerNodes.connectedAutomatically')}</span>
            </div>
            <button
              type="button"
              className="ghost peer-node-remove"
              onClick={() => void controller.forgetPeerNode(peer.nodeId)}
            >
              {t('peerNodes.remove')}
            </button>
          </article>
        ))}
      </div>

      {!controller.pendingPeer ? (
        <div className="peer-discovery-shell">
          <div className="peer-discovery-head">
            <div>
              <span className="eyebrow">{t('peerNodes.discoveryKicker')}</span>
              <strong>{t('peerNodes.addTitle')}</strong>
              <p>{t('peerNodes.discoveryHint')}</p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => void controller.refreshNearbyNodes()}
            >
              {t('peerNodes.searchAgain')}
            </button>
          </div>

          {nearby.length > 0 ? (
            <div className="peer-discovery-grid">
              {nearby.map(node => (
                <article key={node.nodeId} className="peer-discovery-card">
                  <div className="peer-discovery-icon" aria-hidden="true">
                    <span />
                  </div>
                  <div className="peer-discovery-copy">
                    <strong>{node.displayName}</strong>
                    <small>{t('peerNodes.liveNodeFound')}</small>
                    <span>{t('peerNodes.readyToPair')}</span>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={Boolean(busyNodeId)}
                    onClick={() => void startPairing(node.baseUrl, node.nodeId)}
                  >
                    {busyNodeId === node.nodeId
                      ? t('peerNodes.connecting')
                      : t('peerNodes.connect')}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="peer-discovery-empty">
              <div className={`discovery-orb ${controller.discoveryStatus === 'online' ? 'searching' : 'warn'}`} />
              <div>
                <strong>{controller.discoveryStatus === 'online'
                  ? t('peerNodes.searchingNearby')
                  : t('peerNodes.discoveryUnavailable')}</strong>
                <p>{controller.discoveryStatus === 'online'
                  ? t('peerNodes.searchingNearbyHint')
                  : t('peerNodes.discoveryUnavailableHint')}</p>
              </div>
            </div>
          )}

          <details className="peer-node-advanced">
            <summary>{t('peerNodes.advanced')}</summary>
            <div className="peer-node-add">
              <div>
                <strong>{t('peerNodes.manualTitle')}</strong>
                <p>{t('peerNodes.manualHint')}</p>
              </div>
              <div className="peer-node-add-form">
                <input
                  value={address}
                  onChange={event => setAddress(event.target.value)}
                  placeholder={t('peerNodes.addressPlaceholder')}
                  autoComplete="off"
                  inputMode="url"
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={Boolean(busyNodeId) || !address.trim()}
                  onClick={() => void manualPair()}
                >
                  {busyNodeId === 'manual' ? t('peerNodes.connecting') : t('peerNodes.connect')}
                </button>
              </div>
            </div>
          </details>
        </div>
      ) : (
        <div className="peer-node-pairing pairing-premium">
          <div>
            <span className="eyebrow">{t('peerNodes.securePairing')}</span>
            <strong>{t('peerNodes.enterRemotePin')}</strong>
            <p>{t('peerNodes.pinHint')}</p>
          </div>
          <div className="peer-node-pin-form">
            <input
              value={pin}
              onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <button
              type="button"
              className="primary"
              disabled={Boolean(busyNodeId) || pin.length !== 6}
              onClick={() => void completePairing()}
            >
              {busyNodeId ? t('peerNodes.connecting') : t('peerNodes.confirm')}
            </button>
          </div>
        </div>
      )}

      {controller.peerErrorCode && (
        <div className="peer-node-error">
          {t(`nodeErrors.${controller.peerErrorCode}`, {
            defaultValue: controller.peerErrorCode
          })}
        </div>
      )}
    </section>
  );
}
