const steps = [
  {
    title: 'Mantenha a internet no Ethernet',
    body: 'O NestLive usa esta interface para nuvem e autenticação. Não desconecte o cabo.',
    expected: 'Ethernet aparece online.'
  },
  {
    title: 'Conecte o adaptador Wi‑Fi USB',
    body: 'Ele será reservado para a rede da mesa, sem criar ponte entre as redes.',
    expected: 'Uma segunda interface Wi‑Fi aparece.'
  },
  {
    title: 'Entre na rede da mesa',
    body: 'No Windows, conecte o Wi‑Fi USB ao roteador exclusivo da console.',
    expected: 'A rede da mesa fica conectada e a internet continua no Ethernet.'
  },
  {
    title: 'Procurar mesa',
    body: 'O NestLive testa somente leitura primeiro. Nenhum áudio é alterado nesta etapa.',
    expected: 'Modelo, canais e telemetria são identificados.'
  }
];

export function GuidedSetup() {
  return (
    <section className="setup">
      <header className="section-heading">
        <div>
          <span className="eyebrow">GUIDED SETUP</span>
          <h1>Conectar mesa de áudio</h1>
        </div>
        <span className="pill">sem IP no fluxo normal</span>
      </header>

      <div className="setup__steps">
        {steps.map((step, index) => (
          <article className="setup-step" key={step.title}>
            <span className="setup-step__number">{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
              <small>Resultado esperado: {step.expected}</small>
            </div>
            <button type="button">Já fiz — verificar</button>
          </article>
        ))}
      </div>
      <div className="setup__guardrail">
        NestLive nunca habilita Ponte de Rede, ICS, hotspot ou NAT silenciosamente.
      </div>
    </section>
  );
}
