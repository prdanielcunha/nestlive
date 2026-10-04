import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

export function ChannelInspector(props: {
  channel?: MixChannelViewModel;
  stale: boolean;
}) {
  if (!props.channel) {
    return (
      <aside className="inspector inspector--empty">
        <p>Selecione um canal para ver detalhes.</p>
      </aside>
    );
  }

  const channel = props.channel;

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
          <strong>{channel.faderDb.toFixed(1)} dB</strong>
        </div>
        <input
          className="fader"
          type="range"
          min="-90"
          max="10"
          step="0.5"
          value={channel.faderDb}
          readOnly
          aria-label={`Fader de ${channel.name}`}
        />
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

      <p className="inspector__note">
        Controles de escrita só aparecem quando o provider confirma a capability.
      </p>
    </aside>
  );
}
