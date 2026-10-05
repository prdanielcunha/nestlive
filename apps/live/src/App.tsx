import { useEffect, useMemo, useState } from 'react';
import type {
  AudioChannelProcessingState,
  MeterFrame
} from '@millionsnest/nestlive-domain';
import { AudioDoctorPanel } from './AudioDoctorPanel';
import { AudioScenePanel } from './AudioScenePanel';
import { ChannelInspector } from './ChannelInspector';
import { GuidedSetup } from './GuidedSetup';
import { HealthCenter } from './HealthCenter';
import { MixSurface } from './MixSurface';
import { SoundcheckView } from './SoundcheckView';
import { createDemoFrame, demoChannels } from './demo';
import { buildMixChannelViewModels } from './uiModel';
import { useNestLiveAudio } from './useNestLiveAudio';
import { NodePairingPanel } from './NodePairingPanel';
import {
  clearStoredNodeConnection,
  loadStoredNodeConnection,
  saveStoredNodeConnection
} from './nodePairing';
import type { NestLiveNodeConnection } from './audioNodeApiClient';

type Surface =
  | 'mix'
  | 'soundcheck'
  | 'doctor'
  | 'scenes'
  | 'health'
  | 'setup';

const environmentNode: NestLiveNodeConnection | undefined =
  import.meta.env.VITE_NESTLIVE_NODE_HTTP &&
  import.meta.env.VITE_NESTLIVE_NODE_TOKEN
    ? {
        httpBaseUrl: import.meta.env.VITE_NESTLIVE_NODE_HTTP as string,
        wsUrl:
          (import.meta.env.VITE_NESTLIVE_NODE_WS as string | undefined) ??
          '',
        token: import.meta.env.VITE_NESTLIVE_NODE_TOKEN as string,
        providerInstanceId: import.meta.env
          .VITE_NESTLIVE_PROVIDER_ID as string | undefined
      }
    : undefined;

export function App() {
  const [surface, setSurface] = useState<Surface>('mix');
  const [selectedId, setSelectedId] = useState('ch-01');
  const [demoFrame, setDemoFrame] = useState<MeterFrame>(() =>
    createDemoFrame(1)
  );
  const [now, setNow] = useState(Date.now());
  const [storedNode, setStoredNode] = useState<
    NestLiveNodeConnection | undefined
  >(() => loadStoredNodeConnection());
  const configuredNode = environmentNode ?? storedNode;
  const isDemo = !configuredNode && import.meta.env.DEV;
  const audio = useNestLiveAudio(configuredNode);
  const [processing, setProcessing] =
    useState<AudioChannelProcessingState>();
  const [processingLoading, setProcessingLoading] = useState(false);
  const [processingError, setProcessingError] = useState<string>();
  const [processingRefresh, setProcessingRefresh] = useState(0);

  useEffect(() => {
    if (!isDemo) return;
    let tick = 1;
    const meterTimer = window.setInterval(() => {
      tick += 1;
      setDemoFrame(createDemoFrame(tick));
    }, 40);
    return () => window.clearInterval(meterTimer);
  }, [isDemo]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const disconnectedFrame: MeterFrame = {
    providerInstanceId: 'disconnected',
    sequence: 0,
    capturedAt: now,
    channels: []
  };
  const frame = configuredNode
    ? audio.frame ?? disconnectedFrame
    : isDemo
      ? demoFrame
      : disconnectedFrame;
  const sourceChannels =
    configuredNode && audio.channels.length > 0
      ? audio.channels
      : isDemo
        ? demoChannels
        : [];
  const stale = now - frame.capturedAt > 750;

  const channels = useMemo(
    () => buildMixChannelViewModels(sourceChannels, frame),
    [sourceChannels, frame]
  );
  const selected =
    channels.find(channel => channel.id === selectedId) ?? channels[0];

  useEffect(() => {
    if (!channels.some(channel => channel.id === selectedId) && channels[0]) {
      setSelectedId(channels[0].id);
    }
  }, [channels, selectedId]);

  const capabilities = new Set(audio.provider?.capabilities ?? []);

  useEffect(() => {
    if (
      isDemo ||
      !configuredNode ||
      audio.status !== 'online' ||
      !selected?.id ||
      !audio.provider
    ) {
      setProcessing(undefined);
      setProcessingError(undefined);
      return;
    }

    let alive = true;
    setProcessingLoading(true);
    setProcessingError(undefined);

    void audio
      .getProcessing(selected.id)
      .then(value => {
        if (alive) setProcessing(value);
      })
      .catch(error => {
        if (!alive) return;
        setProcessing(undefined);
        setProcessingError(
          error instanceof Error
            ? error.message
            : 'processing_read_failed'
        );
      })
      .finally(() => {
        if (alive) setProcessingLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [
    audio.provider?.providerInstanceId,
    audio.processingRevision,
    audio.status,
    configuredNode,
    isDemo,
    processingRefresh,
    selected?.id
  ]);

  useEffect(() => {
    if (!configuredNode && !isDemo) {
      setSurface('setup');
    }
  }, [configuredNode, isDemo]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">N</span>
          <div>
            <strong>NestLive</strong>
            <small>Mix</small>
          </div>
        </div>

        <nav aria-label="NestLive Mix">
          {([
            ['mix', 'Mix'],
            ['soundcheck', 'Soundcheck'],
            ['doctor', 'Audio Doctor'],
            ['scenes', 'Cenas'],
            ['health', 'Health'],
            ['setup', 'Configurar']
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-active={surface === id}
              onClick={() => setSurface(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar__footer">
          <span
            className="status-dot"
            data-offline={audio.status === 'offline' || audio.status === 'error'}
          />
          <div>
            <strong>
              {isDemo
                ? 'Simulador local'
                : !configuredNode
                  ? 'Node desconectado'
                  : audio.status === 'online'
                    ? 'Node conectado'
                    : 'Conectando Node'}
            </strong>
            <small>
              {isDemo
                ? 'preview de desenvolvimento'
                : configuredNode
                  ? audio.provider?.providerInstanceId ?? audio.error ?? 'aguarde'
                  : 'conecte um computador'}
            </small>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">
              {isDemo
                ? 'AMBIENTE DE DESENVOLVIMENTO'
                : configuredNode
                  ? 'NESTLIVE NODE'
                  : 'NESTLIVE'}
            </span>
            <strong>
              {audio.provider?.providerInstanceId ??
                (isDemo
                  ? 'Console simulada'
                  : configuredNode
                    ? 'Áudio'
                    : 'Conectar computador')}
            </strong>
          </div>
          <div className="topbar__status">
            <span className="pill">
              ● {isDemo
                ? 'Demo'
                : configuredNode
                  ? audio.status
                  : 'desconectado'}
            </span>
            <a className="pill workspace-link" href="/production/">
              Produção
            </a>
            {stale ? <span className="pill pill--danger">Meter stale</span> : null}
          </div>
        </header>

        {surface === 'mix' ? (
          <div className="mix-layout">
            <div className="mix-layout__main">
              <header className="section-heading">
                <div>
                  <span className="eyebrow">MIX</span>
                  <h1>Quem está com sinal?</h1>
                </div>
                <span className="pill">estado observado</span>
              </header>
              <MixSurface
                channels={channels}
                selectedId={selected?.id}
                onSelect={setSelectedId}
                stale={stale}
              />
              <div className="main-meter-card">
                <div>
                  <span className="eyebrow">MAIN LR</span>
                  <strong>{frame.mains?.[0]?.peakDb?.toFixed(1) ?? '—'} dB</strong>
                </div>
                <div className="main-meter-card__bar">
                  <span
                    style={{
                      inlineSize: `${Math.max(
                        0,
                        Math.min(
                          100,
                          (((frame.mains?.[0]?.peakDb ?? -60) + 60) / 60) * 100
                        )
                      )}%`
                    }}
                  />
                </div>
              </div>
            </div>
            <ChannelInspector
              channel={selected}
              stale={stale}
              capabilities={isDemo ? new Set() : capabilities}
              onCommand={
                isDemo
                  ? undefined
                  : (command, safety) => audio.execute(command, safety)
              }
              processing={processing}
              processingLoading={processingLoading}
              processingError={processingError}
              onProcessingRefresh={() =>
                setProcessingRefresh(value => value + 1)
              }
            />
          </div>
        ) : null}

        {surface === 'soundcheck' ? (
          <SoundcheckView channels={channels} stale={stale} />
        ) : null}
        {surface === 'doctor' ? (
          <AudioDoctorPanel
            channel={selected}
            stale={stale}
            providerOnline={
              isDemo || audio.status === 'online'
            }
          />
        ) : null}
        {surface === 'scenes' ? (
          <AudioScenePanel
            enabled={
              !isDemo &&
              capabilities.has('audio.scene.recall')
            }
            onCommand={
              isDemo
                ? undefined
                : (command, safety) => audio.execute(command, safety)
            }
          />
        ) : null}
        {surface === 'health' ? (
          <HealthCenter
            stale={stale}
            connected={isDemo || audio.status === 'online'}
            channelCount={channels.length}
            network={audio.network}
          />
        ) : null}
        {surface === 'setup' ? (
          <>
            <NodePairingPanel
              connected={Boolean(configuredNode)}
              connection={configuredNode}
              onConnected={connection => {
                saveStoredNodeConnection(connection);
                setStoredNode(connection);
              }}
              onDisconnect={() => {
                clearStoredNodeConnection();
                setStoredNode(undefined);
              }}
            />
            <GuidedSetup
              connectedToNode={
                Boolean(configuredNode) && audio.status !== 'error'
              }
              inspectNetwork={audio.inspectNetwork}
              discoverX32={audio.discoverX32}
              connectX32={audio.connectX32}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}
