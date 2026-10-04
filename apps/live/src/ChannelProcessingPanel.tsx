import { useEffect, useMemo, useState } from 'react';
import type {
  AudioChannelProcessingState,
  AudioControlCommand
} from '@millionsnest/nestlive-domain';

type CommandRunner = (
  command: AudioControlCommand,
  safety?: 'normal' | 'guarded' | 'critical'
) => Promise<unknown>;

const RATIOS = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];

function number(
  event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
): number {
  return Number(event.target.value);
}

export function ChannelProcessingPanel(props: {
  processing?: AudioChannelProcessingState;
  capabilities: ReadonlySet<string>;
  loading?: boolean;
  error?: string;
  onCommand?: CommandRunner;
  onRefresh?: () => void;
}) {
  const [gain, setGain] = useState(0);
  const [eq, setEq] = useState<AudioChannelProcessingState['eq']>();
  const [gate, setGate] = useState<AudioChannelProcessingState['gate']>();
  const [compressor, setCompressor] =
    useState<AudioChannelProcessingState['compressor']>();
  const [busy, setBusy] = useState<string>();
  const [confirmPhantom, setConfirmPhantom] = useState(false);

  useEffect(() => {
    if (!props.processing) return;
    setGain(props.processing.gainDb ?? 0);
    setEq(structuredClone(props.processing.eq));
    setGate(structuredClone(props.processing.gate));
    setCompressor(structuredClone(props.processing.compressor));
    setConfirmPhantom(false);
  }, [props.processing]);

  const deepEnabled = useMemo(
    () =>
      [
        'audio.gain.write',
        'audio.phantom.write',
        'audio.eq.write',
        'audio.gate.write',
        'audio.compressor.write'
      ].some(capability => props.capabilities.has(capability)),
    [props.capabilities]
  );

  const run = async (
    key: string,
    command: AudioControlCommand,
    safety: 'normal' | 'guarded' | 'critical'
  ) => {
    if (!props.onCommand) return;
    setBusy(key);
    try {
      await props.onCommand(command, safety);
      props.onRefresh?.();
    } finally {
      setBusy(undefined);
    }
  };

  if (props.loading && !props.processing) {
    return (
      <section className="processing-card processing-card--loading">
        Lendo processamento real da mesa…
      </section>
    );
  }

  if (!props.processing) {
    return (
      <section className="processing-card processing-card--unavailable">
        <strong>Processamento</strong>
        <p>
          {props.error ??
            'A mesa conectada ainda não expõe processamento profundo.'}
        </p>
      </section>
    );
  }

  const p = props.processing;
  const channelId = p.channelId;
  const canGain = props.capabilities.has('audio.gain.write');
  const canPhantom = props.capabilities.has('audio.phantom.write');
  const canEq = props.capabilities.has('audio.eq.write');
  const canGate = props.capabilities.has('audio.gate.write');
  const canCompressor =
    props.capabilities.has('audio.compressor.write');

  return (
    <section className="processing-card">
      <header className="processing-card__header">
        <div>
          <span className="eyebrow">PROCESSAMENTO</span>
          <strong>Canal observado</strong>
        </div>
        <span className="pill">
          {deepEnabled ? 'controle certificado' : 'somente leitura'}
        </span>
      </header>

      <div className="processing-block">
        <div className="processing-block__title">
          <div>
            <strong>Preamp</strong>
            <small>
              {p.headampIndex === undefined
                ? 'Fonte sem headamp físico controlável'
                : `Headamp ${String(p.headampIndex).padStart(3, '0')}`}
            </small>
          </div>
          <span className="observed-value">
            {p.gainDb === undefined ? '—' : `${p.gainDb.toFixed(1)} dB`}
          </span>
        </div>

        {p.headampIndex !== undefined && p.gainDb !== undefined ? (
          <div className="processing-control">
            <div className="field-row">
              <label htmlFor="gain-control">Gain</label>
              <strong>{gain.toFixed(1)} dB</strong>
            </div>
            <input
              id="gain-control"
              className="fader"
              type="range"
              min="-12"
              max="60"
              step="0.5"
              value={gain}
              disabled={!canGain || Boolean(busy)}
              onChange={event => setGain(number(event))}
            />
            {canGain ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run(
                    'gain',
                    { type: 'setGain', channelId, valueDb: gain },
                    'guarded'
                  )
                }
              >
                Aplicar gain
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="phantom-control">
          <div>
            <span className="label">48V / Phantom</span>
            <strong>{p.phantom === undefined ? '—' : p.phantom ? 'ON' : 'OFF'}</strong>
          </div>
          {canPhantom ? (
            !confirmPhantom ? (
              <button
                type="button"
                className={p.phantom ? '' : 'is-critical'}
                disabled={Boolean(busy)}
                onClick={() => setConfirmPhantom(true)}
              >
                {p.phantom ? 'Desligar 48V' : 'Ligar 48V'}
              </button>
            ) : (
              <div className="critical-inline">
                <strong>Confirmar 48V?</strong>
                <small>
                  Esta ação altera alimentação elétrica do preamp físico.
                </small>
                <div>
                  <button
                    type="button"
                    onClick={() => setConfirmPhantom(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="is-critical"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setConfirmPhantom(false);
                      void run(
                        'phantom',
                        {
                          type: 'setPhantom',
                          channelId,
                          value: !p.phantom
                        },
                        'critical'
                      );
                    }}
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {eq ? (
        <div className="processing-block">
          <div className="processing-block__title">
            <div>
              <strong>EQ paramétrico</strong>
              <small>4 bandas · estado real da X32</small>
            </div>
            <label className="mini-toggle">
              <input
                type="checkbox"
                checked={eq.on}
                disabled={!canEq || Boolean(busy)}
                onChange={event =>
                  setEq(current =>
                    current
                      ? { ...current, on: event.target.checked }
                      : current
                  )
                }
              />
              <span>{eq.on ? 'ON' : 'OFF'}</span>
            </label>
          </div>

          <div className="eq-grid">
            {eq.bands.map((band, bandOffset) => (
              <div className="eq-band" key={band.index}>
                <strong>Band {band.index}</strong>
                <label>
                  <span>Freq</span>
                  <input
                    type="number"
                    min="20"
                    max="20000"
                    step="1"
                    value={Math.round(band.frequencyHz)}
                    disabled={!canEq || Boolean(busy)}
                    onChange={event => {
                      const value = number(event);
                      setEq(current =>
                        current
                          ? {
                              ...current,
                              bands: current.bands.map((item, index) =>
                                index === bandOffset
                                  ? { ...item, frequencyHz: value }
                                  : item
                              )
                            }
                          : current
                      );
                    }}
                  />
                </label>
                <label>
                  <span>Gain</span>
                  <input
                    type="number"
                    min="-15"
                    max="15"
                    step="0.1"
                    value={band.gainDb.toFixed(1)}
                    disabled={!canEq || Boolean(busy)}
                    onChange={event => {
                      const value = number(event);
                      setEq(current =>
                        current
                          ? {
                              ...current,
                              bands: current.bands.map((item, index) =>
                                index === bandOffset
                                  ? { ...item, gainDb: value }
                                  : item
                              )
                            }
                          : current
                      );
                    }}
                  />
                </label>
                <label>
                  <span>Q</span>
                  <input
                    type="number"
                    min="0.3"
                    max="10"
                    step="0.1"
                    value={band.q.toFixed(1)}
                    disabled={!canEq || Boolean(busy)}
                    onChange={event => {
                      const value = number(event);
                      setEq(current =>
                        current
                          ? {
                              ...current,
                              bands: current.bands.map((item, index) =>
                                index === bandOffset
                                  ? { ...item, q: value }
                                  : item
                              )
                            }
                          : current
                      );
                    }}
                  />
                </label>
              </div>
            ))}
          </div>

          {canEq ? (
            <button
              type="button"
              className="apply-processing"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'eq',
                  {
                    type: 'setEq',
                    channelId,
                    eq: {
                      on: eq.on,
                      bands: eq.bands
                    }
                  },
                  'guarded'
                )
              }
            >
              Aplicar EQ
            </button>
          ) : null}
        </div>
      ) : null}

      {gate ? (
        <div className="processing-block">
          <div className="processing-block__title">
            <div>
              <strong>Gate</strong>
              <small>threshold · range · timing</small>
            </div>
            <label className="mini-toggle">
              <input
                type="checkbox"
                checked={gate.on}
                disabled={!canGate || Boolean(busy)}
                onChange={event =>
                  setGate(current =>
                    current
                      ? { ...current, on: event.target.checked }
                      : current
                  )
                }
              />
              <span>{gate.on ? 'ON' : 'OFF'}</span>
            </label>
          </div>

          <div className="processing-fields">
            {([
              ['thresholdDb', 'Threshold', -80, 0, 0.5],
              ['rangeDb', 'Range', 3, 60, 1],
              ['attackMs', 'Attack', 0, 120, 1],
              ['holdMs', 'Hold', 0.02, 2000, 1],
              ['releaseMs', 'Release', 5, 4000, 1]
            ] as const).map(([key, label, min, max, step]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  value={gate[key]}
                  disabled={!canGate || Boolean(busy)}
                  onChange={event => {
                    const value = number(event);
                    setGate(current =>
                      current ? { ...current, [key]: value } : current
                    );
                  }}
                />
              </label>
            ))}
          </div>
          {canGate ? (
            <button
              type="button"
              className="apply-processing"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'gate',
                  { type: 'setGate', channelId, gate },
                  'guarded'
                )
              }
            >
              Aplicar Gate
            </button>
          ) : null}
        </div>
      ) : null}

      {compressor ? (
        <div className="processing-block">
          <div className="processing-block__title">
            <div>
              <strong>Compressor</strong>
              <small>dinâmica completa com read-back</small>
            </div>
            <label className="mini-toggle">
              <input
                type="checkbox"
                checked={compressor.on}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, on: event.target.checked }
                      : current
                  )
                }
              />
              <span>{compressor.on ? 'ON' : 'OFF'}</span>
            </label>
          </div>

          <div className="processing-fields">
            <label>
              <span>Threshold</span>
              <input
                type="number"
                min="-60"
                max="0"
                step="0.5"
                value={compressor.thresholdDb}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, thresholdDb: number(event) }
                      : current
                  )
                }
              />
            </label>
            <label>
              <span>Ratio</span>
              <select
                value={compressor.ratio}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, ratio: number(event) }
                      : current
                  )
                }
              >
                {RATIOS.map(ratio => (
                  <option key={ratio} value={ratio}>
                    {ratio === 100 ? '∞:1' : `${ratio}:1`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Makeup</span>
              <input
                type="number"
                min="0"
                max="24"
                step="0.5"
                value={compressor.makeupGainDb}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, makeupGainDb: number(event) }
                      : current
                  )
                }
              />
            </label>
            <label>
              <span>Attack</span>
              <input
                type="number"
                min="0"
                max="120"
                step="1"
                value={compressor.attackMs}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, attackMs: number(event) }
                      : current
                  )
                }
              />
            </label>
            <label>
              <span>Release</span>
              <input
                type="number"
                min="5"
                max="4000"
                step="1"
                value={compressor.releaseMs}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, releaseMs: number(event) }
                      : current
                  )
                }
              />
            </label>
            <label>
              <span>Mix</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                value={compressor.mixPercent}
                disabled={!canCompressor || Boolean(busy)}
                onChange={event =>
                  setCompressor(current =>
                    current
                      ? { ...current, mixPercent: number(event) }
                      : current
                  )
                }
              />
            </label>
          </div>

          {canCompressor ? (
            <button
              type="button"
              className="apply-processing"
              disabled={Boolean(busy)}
              onClick={() =>
                void run(
                  'compressor',
                  {
                    type: 'setCompressor',
                    channelId,
                    compressor
                  },
                  'guarded'
                )
              }
            >
              Aplicar Compressor
            </button>
          ) : null}
        </div>
      ) : null}

      {!deepEnabled ? (
        <p className="processing-locked">
          Os dados podem ser lidos, mas escrita profunda só aparece após a
          certificação física desta mesa/venue.
        </p>
      ) : null}
    </section>
  );
}
