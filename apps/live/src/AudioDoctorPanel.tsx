import {
  buildSignalTrace,
  diagnoseAudio
} from '@millionsnest/nestlive-domain';
import type { MixChannelViewModel } from './uiModel';

export function AudioDoctorPanel(props: {
  channel?: MixChannelViewModel;
  stale: boolean;
  providerOnline: boolean;
}) {
  if (!props.channel) return null;

  const input = {
    channelId: props.channel.id,
    channelName: props.channel.name,
    providerOnline: props.providerOnline,
    telemetryStale: props.stale,
    inputDb: props.channel.preFaderDb,
    postFaderDb: props.channel.postFaderDb,
    outputDb: undefined,
    faderDb: props.channel.faderDb,
    muted: props.channel.mute,
    groupMuted: undefined,
    gateOpen: props.channel.gateOpen,
    gainReductionDb: props.channel.gainReductionDb,
    assignedToMain: undefined,
    clip: props.channel.clip
  };

  const findings = diagnoseAudio(input);
  const trace = buildSignalTrace(input);

  return (
    <section className="doctor">
      <header>
        <div>
          <span className="eyebrow">AUDIO DOCTOR</span>
          <h2>Signal Trace</h2>
        </div>
        <span className="pill">dados observados</span>
      </header>

      <p className="doctor__disclaimer">
        O NestLive marca como “não disponível” qualquer ponto que a mesa ainda
        não expôs. Nenhuma etapa é inventada para completar o diagnóstico.
      </p>

      <div className="signal-trace">
        {trace.map(step => (
          <div className="trace-step" key={step.id} data-status={step.status}>
            <span className="trace-step__dot" aria-hidden="true" />
            <div>
              <strong>{step.label}</strong>
              <span>{step.value ?? 'não disponível'}</span>
            </div>
            <small>
              {step.evidence === 'inferred' ? 'inferido' : step.evidence}
            </small>
          </div>
        ))}
      </div>

      <div className="doctor__findings">
        {findings.length === 0 ? (
          <p className="doctor__ok">
            Nenhum bloqueio foi comprovado com os dados disponíveis.
          </p>
        ) : (
          findings.map(finding => (
            <article key={finding.code} data-severity={finding.severity}>
              <strong>{finding.title}</strong>
              <p>{finding.explanation}</p>
              {finding.evidence === 'inferred' ? (
                <small>Conclusão inferida</small>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
