import type {
  NetworkInterface,
  ProviderNetworkBinding
} from '@millionsnest/nestlive-domain';
import type { GuidedNetworkPlan } from './audioNodeApiClient';

export function HealthCenter(props: {
  stale: boolean;
  connected: boolean;
  channelCount: number;
  network?: {
    interfaces: NetworkInterface[];
    bindings?: ProviderNetworkBinding[];
    plan: GuidedNetworkPlan;
  };
}) {
  const binding = props.network?.bindings?.[0];
  const cloud = props.network?.interfaces.find(
    item => item.id === props.network?.plan.cloudInterfaceId
  );
  const audio = binding
    ? props.network?.interfaces.find(
        item => item.id === binding.networkInterfaceId
      )
    : props.network?.interfaces.find(
        item => item.id === props.network?.plan.audioInterfaceId
      );

  const networkState = binding?.health
    ? binding.health.toUpperCase()
    : props.connected
      ? 'ONLINE'
      : 'VERIFICAR';

  const rows = [
    ['Mesa', props.connected ? 'ONLINE' : 'OFFLINE'],
    ['Rede da mesa', networkState],
    [
      'Interface de áudio',
      audio ? audio.humanName : 'não identificada'
    ],
    [
      'Latência LAN',
      binding?.latencyMs === undefined
        ? '—'
        : `${binding.latencyMs.toFixed(0)} ms`
    ],
    [
      'Perda LAN',
      binding?.packetLossPercent === undefined
        ? '—'
        : `${binding.packetLossPercent.toFixed(0)}%`
    ],
    ['Meter stream', props.stale ? 'CONGELADO' : 'FLUINDO'],
    ['Canais', String(props.channelCount)],
    ['Estado', props.stale ? 'RECONCILIANDO' : 'SINCRONIZADO'],
    [
      'Internet',
      cloud
        ? `${cloud.humanName} · gateway preservado`
        : 'não obrigatória para Mix local'
    ]
  ];

  return (
    <section className="health">
      <header className="section-heading">
        <div>
          <span className="eyebrow">HEALTH CENTER</span>
          <h1>Áudio</h1>
        </div>
        {binding ? (
          <span className="pill">
            binding {binding.health}
          </span>
        ) : null}
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
