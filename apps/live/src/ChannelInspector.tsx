import { useEffect, useState } from 'react';
import type { AudioControlCommand } from '@millionsnest/nestlive-domain';
import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

export function ChannelInspector(props: {
  channel?: MixChannelViewModel;
  stale: boolean;
  capabilities?: ReadonlySet<string>;
  onCommand?: (
    command: AudioControlCommand,
    confirmedSafetyLevel?: 'normal' | 'guarded' | 'critical'
  ) => Promise<unknown>;
}) {
  const [draftFader, setDraftFader] = useState(-96);
  const [confirmMute, setConfirmMute] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.channel) setDraftFader(props.channel.faderDb);
    setConfirmMute(false);
  }, [props.channel?.id, props.channel?.faderDb]);

  if (!props.channel) {
    return (
      <aside className="inspector inspector--empty">
        <p>Selecione um canal para ver detalhes.</p>
      </aside>
    );
  }

  const channel = props.channel;
  const canFader = props.capabilities?.has('audio.fader.write') ?? false;
  const canMute = props.capabilities?.has('audio.mute.write') ?? false;

  const run = async (
    command: AudioControlCommand,
    safety?: 'normal' | 'guarded' | 'critical'
  ) => {
    if (!props.onCommand) return;
    setBusy(true);
    try {
      await props.onCommand(command, safety);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="inspector" aria-label={`Detalhes de ${channel.name}`}>
      <div className="inspector__eyebrow">
        CH {String(channel.index).padStart(2, '0')}
      </div>
      <h2>{channel.name}</h2>
      <MeterBar
        db={channel.meterDb}
        peakDb={channel.peakDb}
        clip={channel.clip}
        available={channel.meterAvailable}
        stale={props.stale}
      />

      <div className="inspector__section">
        <div className="field-row">
          <span>Fader</span>
          <strong>{draftFader.toFixed(1)} dB</strong>
        </div>
        {canFader ? (
          <>
            <input
              className="fader"
              type="range"
              min="-90"
              max="10"
              step="0.5"
              value={draftFader}
              disabled={busy}
              onChange={event => setDraftFader(Number(event.target.value))}
              onPointerUp={() => {
                void run({
                  type: 'setFader',
                  channelId: channel.id,
                  valueDb: draftFader
                });
              }}
              onKeyUp={event => {
                if (event.key === 'Enter') {
                  void run({
                    type: 'setFader',
                    channelId: channel.id,
                    valueDb: draftFader
                  });
                }
              }}
              aria-label={`Fader de ${channel.name}`}
            />
            <small className="control-hint">
              A alteração só é assumida depois da confirmação da mesa.
            </small>
          </>
        ) : (
          <div className="capability-unavailable">
            Controle de fader não disponível neste provider.
          </div>
        )}
      </div>

      <div className="inspector__section inspector__grid">
        <div>
          <span className="label">Mute</span>
          <strong>{channel.mute ? 'ON' : 'OFF'}</strong>
        </div>
        <div>
          <span className="label">Peak</span>
          <strong>{channel.peakDb.toFixed(1)} dB</strong>
        </div>
        <div>
          <span className="label">Estado</span>
          <strong>{props.stale ? 'Stale' : 'Observado'}</strong>
        </div>
      </div>

      {canMute ? (
        <div className="inspector__section">
          {!confirmMute ? (
            <button
              className={channel.mute ? 'control-button' : 'control-button control-button--danger'}
              type="button"
              disabled={busy}
              onClick={() => setConfirmMute(true)}
            >
              {channel.mute ? 'Desmutar canal' : 'Mutar canal'}
            </button>
          ) : (
            <div className="safety-confirm">
              <strong>
                {channel.mute ? 'Desmutar' : 'Mutar'} “{channel.name}”?
              </strong>
              <p>
                {channel.mute
                  ? 'O áudio deste canal voltará a passar.'
                  : 'Isso interrompe imediatamente o áudio deste canal.'}
              </p>
              <div>
                <button type="button" onClick={() => setConfirmMute(false)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="control-button--danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmMute(false);
                    void run(
                      {
                        type: 'setMute',
                        channelId: channel.id,
                        value: !channel.mute
                      },
                      'guarded'
                    );
                  }}
                >
                  Confirmar
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <p className="inspector__note">
        Controles só aparecem quando a mesa/provider confirma a capability.
      </p>
    </aside>
  );
}
