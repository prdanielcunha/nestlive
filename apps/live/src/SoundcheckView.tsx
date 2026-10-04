import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

export function SoundcheckView(props: {
  channels: MixChannelViewModel[];
  stale: boolean;
}) {
  return (
    <section className="soundcheck">
      <header className="section-heading">
        <div>
          <span className="eyebrow">SOUNDCHECK</span>
          <h1>Passagem de som</h1>
        </div>
        <span className="pill">{props.channels.length} canais</span>
      </header>

      <div className="soundcheck__list">
        {props.channels.map((channel, index) => (
          <article className="soundcheck-row" key={channel.id}>
            <span className="soundcheck-row__state" aria-hidden="true">
              {index < 3 ? '✓' : index === 3 ? '●' : '○'}
            </span>
            <div className="soundcheck-row__title">
              <strong>{channel.name}</strong>
              <small>
                {index < 3 ? 'checado' : index === 3 ? 'testando' : 'pendente'}
              </small>
            </div>
            <MeterBar
              compact
              db={channel.meterDb}
              peakDb={channel.peakDb}
              clip={channel.clip}
              available={channel.meterAvailable}
              stale={props.stale}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
