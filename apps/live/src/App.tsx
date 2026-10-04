import { useEffect, useMemo, useState } from 'react';
import type { MeterFrame } from '@millionsnest/nestlive-domain';
import { AudioDoctorPanel } from './AudioDoctorPanel';
import { ChannelInspector } from './ChannelInspector';
import { GuidedSetup } from './GuidedSetup';
import { HealthCenter } from './HealthCenter';
import { MixSurface } from './MixSurface';
import { SoundcheckView } from './SoundcheckView';
import { createDemoFrame, demoChannels } from './demo';
import { buildMixChannelViewModels } from './uiModel';
import { useNestLiveAudio } from './useNestLiveAudio';

type Surface = 'mix' | 'soundcheck' | 'doctor' | 'health' | 'setup';

const configuredNode =
  import.meta.env.VITE_NESTLIVE_NODE_HTTP &&
  import.meta.env.VITE_NESTLIVE_NODE_WS &&
  import.meta.env.VITE_NESTLIVE_NODE_TOKEN
    ? {
        httpBaseUrl: import.meta.env.VITE_NESTLIVE_NODE_HTTP as string,
        wsUrl: import.meta.env.VITE_NESTLIVE_NODE_WS as string,
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
  const audio = useNestLiveAudio(configuredNode);

  useEffect(() => {
    if (configuredNode) return;
    let tick = 1;
    const meterTimer = window.setInterval(() => {
      tick += 1;
      setDemoFrame(createDemoFrame(tick));
    }, 40);
    return () => window.clearInterval(meterTimer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const frame = configuredNode ? audio.frame ?? demoFrame : demoFrame;
  const sourceChannels =
    configuredNode && audio.channels.length > 0
      ? audio.channels
      : demoChannels;
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
  const isDemo = !configuredNode;

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
                : audio.status === 'online'
                  ? 'Node conectado'
                  : 'Conectando Node'}
            </strong>
            <small>
              {isDemo
                ? 'preview de desenvolvimento'
                : audio.provider?.providerInstanceId ?? audio.error ?? 'aguarde'}
            </small>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">
              {isDemo ? 'AMBIENTE DE DESENVOLVIMENTO' : 'NESTLIVE NODE'}
            </span>
            <strong>
              {audio.provider?.providerInstanceId ??
                (isDemo ? 'Console simulada' : 'Áudio')}
            </strong>
          </div>
          <div className="topbar__status">
            <span className="pill">
              ● {isDemo ? 'Demo' : audio.status}
            </span>
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
            />
          </div>
        ) : null}

        {surface === 'soundcheck' ? (
          <SoundcheckView channels={channels} stale={stale} />
        ) : null}
        {surface === 'doctor' ? (
          <AudioDoctorPanel channel={selected} stale={stale} />
        ) : null}
        {surface === 'health' ? (
          <HealthCenter
            stale={stale}
            connected={isDemo || audio.status === 'online'}
            channelCount={channels.length}
          />
        ) : null}
        {surface === 'setup' ? (
          <GuidedSetup
            connectedToNode={Boolean(configuredNode) && audio.status !== 'error'}
            inspectNetwork={audio.inspectNetwork}
            discoverX32={audio.discoverX32}
            connectX32={audio.connectX32}
          />
        ) : null}
      </main>
    </div>
  );
}
