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

type Surface = 'mix' | 'soundcheck' | 'doctor' | 'health' | 'setup';

export function App() {
  const [surface, setSurface] = useState<Surface>('mix');
  const [selectedId, setSelectedId] = useState('ch-01');
  const [frame, setFrame] = useState<MeterFrame>(() => createDemoFrame(1));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let tick = 1;
    const meterTimer = window.setInterval(() => {
      tick += 1;
      setFrame(createDemoFrame(tick));
    }, 40);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 250);
    return () => {
      window.clearInterval(meterTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const stale = now - frame.capturedAt > 750;
  const channels = useMemo(
    () => buildMixChannelViewModels(demoChannels, frame),
    [frame]
  );
  const selected = channels.find(channel => channel.id === selectedId);

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
          <span className="status-dot" />
          <div>
            <strong>Simulador local</strong>
            <small>30 fps · LAN preview</small>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">MONTE CASTELO</span>
            <strong>Behringer X32</strong>
          </div>
          <div className="topbar__status">
            <span className="pill">● Online</span>
            <span className="pill">Simulador</span>
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
                selectedId={selectedId}
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
            <ChannelInspector channel={selected} stale={stale} />
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
            connected
            channelCount={channels.length}
          />
        ) : null}
        {surface === 'setup' ? <GuidedSetup /> : null}
      </main>
    </div>
  );
}
