import { useState } from 'react';
import type {
  GuidedNetworkPlan,
  X32DiscoveryResult
} from './audioNodeApiClient';

type SetupState =
  | 'idle'
  | 'checking-network'
  | 'network-ready'
  | 'network-blocked'
  | 'discovering'
  | 'console-found'
  | 'connecting'
  | 'connected'
  | 'error';

export function GuidedSetup(props: {
  connectedToNode: boolean;
  inspectNetwork?: () => Promise<{ plan: GuidedNetworkPlan }>;
  discoverX32?: () => Promise<X32DiscoveryResult[]>;
  connectX32?: (address: string) => Promise<unknown>;
}) {
  const [state, setState] = useState<SetupState>('idle');
  const [plan, setPlan] = useState<GuidedNetworkPlan>();
  const [consoles, setConsoles] = useState<X32DiscoveryResult[]>([]);
  const [error, setError] = useState<string>();

  const verifyNetwork = async () => {
    if (!props.inspectNetwork) return;
    setError(undefined);
    setState('checking-network');
    try {
      const result = await props.inspectNetwork();
      setPlan(result.plan);
      setState(
        result.plan.readyForReadOnlyProbe
          ? 'network-ready'
          : 'network-blocked'
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'network_check_failed');
      setState('error');
    }
  };

  const discover = async () => {
    if (!props.discoverX32) return;
    setError(undefined);
    setState('discovering');
    try {
      const found = await props.discoverX32();
      setConsoles(found);
      setState(found.length ? 'console-found' : 'network-ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'x32_discovery_failed');
      setState('error');
    }
  };

  const connect = async (console: X32DiscoveryResult) => {
    if (!props.connectX32) return;
    setError(undefined);
    setState('connecting');
    try {
      await props.connectX32(console.address);
      setState('connected');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'x32_connect_failed');
      setState('error');
    }
  };

  return (
    <section className="setup">
      <header className="section-heading">
        <div>
          <span className="eyebrow">GUIDED SETUP</span>
          <h1>Conectar mesa de áudio</h1>
        </div>
        <span className="pill">sem IP no fluxo normal</span>
      </header>

      {!props.connectedToNode ? (
        <article className="setup-step setup-step--blocked">
          <span className="setup-step__number">1</span>
          <div>
            <strong>Conecte este dispositivo ao NestLive Node</strong>
            <p>
              O teste de rede só fica disponível depois do pareamento seguro com
              o computador de produção.
            </p>
            <small>Nenhum botão técnico é simulado nesta etapa.</small>
          </div>
        </article>
      ) : (
        <>
          <article className="setup-step">
            <span className="setup-step__number">1</span>
            <div>
              <strong>Ethernet para internet + Wi‑Fi USB para a mesa</strong>
              <p>
                O NestLive verifica as interfaces sem criar bridge, ICS, hotspot
                ou NAT.
              </p>
              <small>
                Resultado esperado: duas redes independentes e utilizáveis.
              </small>
            </div>
            <button
              type="button"
              disabled={state === 'checking-network'}
              onClick={() => void verifyNetwork()}
            >
              {state === 'checking-network'
                ? 'Verificando…'
                : 'Já fiz — verificar'}
            </button>
          </article>

          {plan ? (
            <div className="setup__checks">
              {plan.checks.map(check => (
                <article
                  key={check.id}
                  className="setup-check"
                  data-severity={check.severity}
                >
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                  {check.action ? <small>{check.action}</small> : null}
                </article>
              ))}
            </div>
          ) : null}

          {plan?.readyForReadOnlyProbe ? (
            <article className="setup-step">
              <span className="setup-step__number">2</span>
              <div>
                <strong>Procurar Behringer X32</strong>
                <p>
                  A busca envia apenas uma consulta de identificação na subnet da
                  interface de áudio. Nenhum parâmetro da mesa é alterado.
                </p>
                <small>
                  Resultado esperado: modelo, nome, firmware e endereço encontrados.
                </small>
              </div>
              <button
                type="button"
                disabled={state === 'discovering'}
                onClick={() => void discover()}
              >
                {state === 'discovering' ? 'Procurando…' : 'Procurar mesa'}
              </button>
            </article>
          ) : null}

          {state === 'network-ready' && consoles.length === 0 ? (
            <div className="setup__guardrail">
              Nenhuma X32 foi encontrada ainda. Confirme que o Wi‑Fi USB está na
              rede do roteador da mesa e tente novamente.
            </div>
          ) : null}

          {consoles.map(console => (
            <article className="setup-step" key={console.address}>
              <span className="setup-step__number">3</span>
              <div>
                <strong>
                  {console.networkName || console.model || 'Behringer X32'}
                </strong>
                <p>
                  {console.model || 'X32'} · firmware {console.firmware || '—'} ·
                  resposta {console.latencyMs} ms
                </p>
                <small>
                  O endereço técnico fica oculto no fluxo normal e é persistido
                  pelo Node após a conexão.
                </small>
              </div>
              <button
                type="button"
                disabled={state === 'connecting'}
                onClick={() => void connect(console)}
              >
                {state === 'connecting' ? 'Conectando…' : 'Usar esta mesa'}
              </button>
            </article>
          ))}

          {state === 'connected' ? (
            <div className="setup__success">
              Mesa conectada. O NestLive salvou o binding e tentará recuperá-lo
              após reinicialização.
            </div>
          ) : null}

          {error ? (
            <div className="setup__error">
              Não foi possível concluir o teste: {error}
            </div>
          ) : null}
        </>
      )}

      <div className="setup__guardrail">
        NestLive nunca habilita Ponte de Rede, ICS, hotspot ou NAT silenciosamente.
      </div>
    </section>
  );
}
