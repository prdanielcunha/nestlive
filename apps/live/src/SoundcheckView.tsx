import type { ResolvedScaleChannel } from '@millionsnest/nestlive-domain';
import type { MixChannelViewModel } from './uiModel';
import { MeterBar } from './MeterBar';

export function SoundcheckView(props: {
  channels: MixChannelViewModel[];
  stale: boolean;
  scaleContext?: ResolvedScaleChannel[];
}) {
  const scaleByChannel = new Map(
    (props.scaleContext ?? []).map(item => [item.channelId, item])
  );

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
        {props.channels.map((channel, index) => {
          const scale = scaleByChannel.get(channel.id);
          return (
            <article className="soundcheck-row" key={channel.id}>
              <span className="soundcheck-row__state" aria-hidden="true">
                {index < 3 ? '✓' : index === 3 ? '●' : '○'}
              </span>
              <div className="soundcheck-row__title">
                <strong>{scale?.roleName ?? channel.name}</strong>
                <small>
                  {scale?.participant?.displayName
                    ? `${scale.participant.displayName} · `
                    : ''}
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
          );
        })}
      </div>

      <p className="soundcheck__guardrail">
        Trocar a pessoa escalada atualiza apenas o contexto. NestLive não altera
        ganho nem roteamento automaticamente.
      </p>
    </section>
  );
}
