import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

export function MixSurface(props: {
  channels: MixChannelViewModel[];
  selectedId?: string;
  onSelect: (id: string) => void;
  stale: boolean;
}) {
  return (
    <section className="mix-surface" aria-label="Canais da mesa">
      {props.channels.map(channel => (
        <button
          key={channel.id}
          type="button"
          className="channel-strip"
          data-selected={props.selectedId === channel.id}
          onClick={() => props.onSelect(channel.id)}
        >
          <span className="channel-strip__index">
            CH {String(channel.index).padStart(2, '0')}
          </span>
          <strong className="channel-strip__name">{channel.name}</strong>
          <MeterBar
            db={channel.meterDb}
            peakDb={channel.peakDb}
            clip={channel.clip}
            available={channel.meterAvailable}
            stale={props.stale}
          />
          <div className="channel-strip__footer">
            <span>{channel.faderDb.toFixed(1)} dB</span>
            <span className={channel.mute ? 'pill pill--danger' : 'pill'}>
              {channel.mute ? 'MUTADO' : 'ABERTO'}
            </span>
          </div>
        </button>
      ))}
    </section>
  );
}
