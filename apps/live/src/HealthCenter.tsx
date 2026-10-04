export function HealthCenter(props: {
  stale: boolean;
  connected: boolean;
  channelCount: number;
}) {
  const rows = [
    ['Mesa', props.connected ? 'ONLINE' : 'OFFLINE'],
    ['Rede da mesa', props.connected ? 'ONLINE' : 'VERIFICAR'],
    ['Meter stream', props.stale ? 'CONGELADO' : 'FLUINDO'],
    ['Canais', String(props.channelCount)],
    ['Estado', props.stale ? 'RECONCILIANDO' : 'SINCRONIZADO'],
    ['Internet', 'não obrigatória para Mix local']
  ];

  return (
    <section className="health">
      <header className="section-heading">
        <div>
          <span className="eyebrow">HEALTH CENTER</span>
          <h1>Áudio</h1>
        </div>
      </header>
      <div className="health__table">
        {rows.map(([label, value]) => (
          <div className="health-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
