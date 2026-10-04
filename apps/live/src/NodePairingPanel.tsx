import { useEffect, useState } from 'react';
import type { NestLiveNodeConnection } from './audioNodeApiClient';
import {
  beginNodePairing,
  finishNodePairing,
  pairingCandidateFromLocation
} from './nodePairing';

interface Pending {
  baseUrl: string;
  challengeId: string;
  deviceId: string;
  deviceName: string;
  expiresAt: string;
}

export function NodePairingPanel(props: {
  connected: boolean;
  connection?: NestLiveNodeConnection;
  onConnected: (connection: NestLiveNodeConnection) => void;
  onDisconnect: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(
    () => pairingCandidateFromLocation() ?? 'http://127.0.0.1:4317'
  );
  const [pending, setPending] = useState<Pending>();
  const [pin, setPin] = useState('');
  const [status, setStatus] = useState<
    'idle' | 'requesting' | 'waiting' | 'finishing' | 'error'
  >('idle');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const candidate = pairingCandidateFromLocation();
    if (candidate && !props.connected && status === 'idle') {
      setBaseUrl(candidate);
    }
  }, [props.connected, status]);

  const begin = async () => {
    setStatus('requesting');
    setError(undefined);
    try {
      const next = await beginNodePairing(baseUrl);
      setPending({
        baseUrl: next.baseUrl,
        challengeId: next.challenge.challengeId,
        deviceId: next.deviceId,
        deviceName: next.deviceName,
        expiresAt: next.challenge.expiresAt
      });
      setStatus('waiting');
    } catch (cause) {
      setStatus('error');
      setError(
        cause instanceof Error ? cause.message : 'pairing_failed'
      );
    }
  };

  const finish = async () => {
    if (!pending || pin.replace(/\D/g, '').length !== 6) return;
    setStatus('finishing');
    setError(undefined);
    try {
      const connection = await finishNodePairing({
        ...pending,
        pin
      });
      props.onConnected(connection);
      setPin('');
      setPending(undefined);
      setStatus('idle');
    } catch (cause) {
      setStatus('error');
      setError(
        cause instanceof Error ? cause.message : 'pairing_failed'
      );
    }
  };

  if (props.connected && props.connection) {
    return (
      <section className="pair-card pair-card--connected">
        <div>
          <span className="eyebrow">NESTLIVE NODE</span>
          <h2>Computador conectado</h2>
          <p>
            O Mix está usando o Node local em{' '}
            <strong>{props.connection.httpBaseUrl}</strong>.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={props.onDisconnect}>
          Desconectar
        </button>
      </section>
    );
  }

  return (
    <section className="pair-card">
      <div className="pair-card__header">
        <div>
          <span className="eyebrow">PAREAMENTO LOCAL</span>
          <h2>Conectar este dispositivo ao NestLive</h2>
          <p>
            O PIN aparece somente no computador de produção. Nenhuma mesa é
            exposta diretamente à internet.
          </p>
        </div>
        <span className="pill">LAN-first</span>
      </div>

      <label className="pair-field">
        <span>Computador NestLive</span>
        <input
          value={baseUrl}
          onChange={event => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.20:4317"
          disabled={Boolean(pending)}
        />
      </label>

      {!pending ? (
        <button
          type="button"
          className="pair-primary"
          onClick={() => void begin()}
          disabled={status === 'requesting'}
        >
          {status === 'requesting'
            ? 'Procurando Node…'
            : 'Gerar PIN no computador'}
        </button>
      ) : (
        <div className="pair-pin">
          <div>
            <strong>Digite o PIN de 6 números</strong>
            <small>
              Expira às{' '}
              {new Date(pending.expiresAt).toLocaleTimeString('pt-BR')}
            </small>
          </div>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={pin}
            onChange={event =>
              setPin(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
            placeholder="000000"
            maxLength={6}
          />
          <button
            type="button"
            className="pair-primary"
            onClick={() => void finish()}
            disabled={
              pin.length !== 6 || status === 'finishing'
            }
          >
            {status === 'finishing' ? 'Conectando…' : 'Conectar'}
          </button>
          <button
            type="button"
            className="pair-link"
            onClick={() => {
              setPending(undefined);
              setPin('');
              setStatus('idle');
            }}
          >
            Cancelar
          </button>
        </div>
      )}

      {error ? (
        <p className="pair-error">
          Não foi possível conectar: {error}
        </p>
      ) : null}
    </section>
  );
}
