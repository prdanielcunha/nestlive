import { useEffect, useMemo, useState } from 'react';
import type {
  AudioChannel,
  AudioControlCommand,
  AudioSafetyLevel,
  MeterFrame,
  RemoteMeterProfile,
  RemoteMixGrant,
  RemoteRelayScope
} from '@millionsnest/nestlive-domain';
import { ChannelInspector } from './ChannelInspector';
import { MixSurface } from './MixSurface';
import {
  observeRemoteUser,
  remoteEmailSignIn,
  remoteFirebaseConfigured,
  remoteGoogleSignIn,
  remoteSignOut,
  type RemoteFirebaseUser
} from './remoteAuth';
import {
  RemoteMixWebSocketClient,
  type RemoteAudioSnapshot
} from './remoteRelayClient';
import { buildMixChannelViewModels } from './uiModel';

interface RemoteLinkConfig {
  relayUrl: string;
  grantToken: string;
  scope: RemoteRelayScope;
}

function readRemoteLink(): RemoteLinkConfig {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const storedGrant = sessionStorage.getItem('nestlive.remote.grant');
  const grantToken = hash.get('grant') || storedGrant || '';
  if (hash.get('grant')) {
    sessionStorage.setItem('nestlive.remote.grant', grantToken);
    history.replaceState(
      null,
      '',
      `${url.pathname}${url.search}`
    );
  }

  const relayUrl =
    params.get('relay') ||
    import.meta.env.VITE_NESTLIVE_RELAY_URL ||
    '';
  const scope = {
    nodeId: params.get('node') || '',
    organizationId: params.get('org') || '',
    venueId: params.get('venue') || '',
    liveSystemId: params.get('live') || ''
  };
  if (
    !relayUrl ||
    !grantToken ||
    Object.values(scope).some(value => !value)
  ) {
    throw new Error('remote_link_incomplete');
  }

  return { relayUrl, grantToken, scope };
}

function allowedCapabilities(
  snapshot: RemoteAudioSnapshot | undefined,
  grant: RemoteMixGrant | undefined
): Set<string> {
  const supported = new Set(snapshot?.capabilities ?? []);
  const allowed = new Set<string>();
  if (!grant) return allowed;

  for (const capability of supported) {
    if (
      capability.endsWith('.read') &&
      grant.permissions.includes('audio.read')
    ) {
      allowed.add(capability);
    } else if (
      capability === 'audio.fader.write' &&
      grant.permissions.includes('audio.fader.write')
    ) {
      allowed.add(capability);
    } else if (
      capability === 'audio.mute.write' &&
      grant.permissions.includes('audio.mute.write')
    ) {
      allowed.add(capability);
    } else if (
      [
        'audio.pan.write',
        'audio.busSend.write',
        'audio.gain.write',
        'audio.eq.write',
        'audio.gate.write',
        'audio.compressor.write'
      ].includes(capability) &&
      grant.permissions.includes('audio.guarded.write')
    ) {
      allowed.add(capability);
    } else if (
      [
        'audio.phantom.write',
        'audio.scene.recall'
      ].includes(capability) &&
      grant.permissions.includes('audio.critical.write')
    ) {
      allowed.add(capability);
    }
  }
  return allowed;
}

export function RemoteMixApp() {
  const [link, setLink] = useState<RemoteLinkConfig>();
  const [linkError, setLinkError] = useState<string>();
  const [user, setUser] = useState<RemoteFirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [status, setStatus] = useState<
    'connecting' | 'authenticating' | 'online' | 'offline'
  >('offline');
  const [snapshot, setSnapshot] = useState<RemoteAudioSnapshot>();
  const [frame, setFrame] = useState<MeterFrame>();
  const [grant, setGrant] = useState<RemoteMixGrant>();
  const [quality, setQuality] = useState<{
    rttMs?: number;
    profile: RemoteMeterProfile;
  }>({ profile: 'off' });
  const [error, setError] = useState<string>();
  const [client, setClient] = useState<RemoteMixWebSocketClient>();
  const [selectedId, setSelectedId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    try {
      setLink(readRemoteLink());
    } catch (caught) {
      setLinkError(
        caught instanceof Error ? caught.message : 'remote_link_invalid'
      );
    }
  }, []);

  useEffect(() => {
    if (!remoteFirebaseConfigured()) {
      setAuthReady(true);
      return;
    }
    return observeRemoteUser(next => {
      setUser(next);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      500
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!link || !user) return;

    let alive = true;
    let current: RemoteMixWebSocketClient | undefined;

    void user
      .getIdToken(true)
      .then(idToken => {
        if (!alive) return;
        current = new RemoteMixWebSocketClient({
          relayUrl: link.relayUrl,
          idToken,
          grantToken: link.grantToken,
          scope: link.scope,
          onStatus: setStatus,
          onGrant: setGrant,
          onSnapshot: value => {
            setSnapshot(value);
            setSelectedId(currentId =>
              currentId ??
              value.channels[0]?.id
            );
          },
          onMeter: setFrame,
          onQuality: setQuality,
          onError: setError
        });
        setClient(current);
        current.connect();
      })
      .catch(caught => {
        setError(
          caught instanceof Error
            ? caught.message
            : 'remote_auth_failed'
        );
      });

    return () => {
      alive = false;
      current?.disconnect();
      setClient(undefined);
    };
  }, [link, user?.uid]);

  const channels = useMemo(
    () =>
      buildMixChannelViewModels(
        (snapshot?.channels ?? []) as AudioChannel[],
        frame
      ),
    [snapshot, frame]
  );
  const selected = channels.find(item => item.id === selectedId);
  const capabilities = useMemo(
    () => allowedCapabilities(snapshot, grant),
    [snapshot, grant]
  );
  const stale = !frame || now - frame.capturedAt > 1800;

  const runCommand = async (
    command: AudioControlCommand,
    confirmedSafetyLevel?: AudioSafetyLevel
  ) => {
    if (!client || !user) throw new Error('remote_not_connected');
    const execution = await client.command({
      actorId: user.uid,
      command,
      confirmedSafetyLevel
    });
    const observed = execution.result.observedState;
    const channelId =
      'channelId' in command ? command.channelId : undefined;
    if (channelId && observed) {
      setSnapshot(current => {
        if (!current) return current;
        return {
          ...current,
          channels: current.channels.map(channel =>
            channel.id === channelId
              ? { ...channel, ...observed }
              : channel
          )
        };
      });
    }
    return execution;
  };

  const loginEmail = async () => {
    setAuthBusy(true);
    setError(undefined);
    try {
      await remoteEmailSignIn(email.trim(), password);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'login_failed'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  if (linkError) {
    return (
      <main className="remote-gate">
        <div className="remote-gate__card">
          <span className="eyebrow">NESTLIVE REMOTE MIX</span>
          <h1>Link remoto incompleto</h1>
          <p>
            Abra novamente o link enviado pelo responsável técnico da igreja.
          </p>
          <code>{linkError}</code>
        </div>
      </main>
    );
  }

  if (!remoteFirebaseConfigured()) {
    return (
      <main className="remote-gate">
        <div className="remote-gate__card">
          <span className="eyebrow">NESTLIVE REMOTE MIX</span>
          <h1>Autenticação ainda não configurada</h1>
          <p>
            O build precisa das variáveis públicas do Firebase MillionsNest.
          </p>
        </div>
      </main>
    );
  }

  if (!authReady) {
    return (
      <main className="remote-gate">
        <div className="remote-gate__card">Carregando acesso seguro…</div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="remote-gate">
        <div className="remote-gate__card">
          <span className="eyebrow">NESTLIVE REMOTE MIX</span>
          <h1>Entrar na MillionsNest</h1>
          <p>
            Acesso remoto exige identidade MillionsNest e um grant temporário
            emitido pelo NestLive Node.
          </p>
          <button
            type="button"
            className="remote-login-google"
            disabled={authBusy}
            onClick={() => {
              setAuthBusy(true);
              setError(undefined);
              void remoteGoogleSignIn()
                .catch(caught =>
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : 'login_failed'
                  )
                )
                .finally(() => setAuthBusy(false));
            }}
          >
            Continuar com Google
          </button>
          <div className="remote-login-separator">ou</div>
          <label>
            <span>E-mail</span>
            <input
              value={email}
              onChange={event => setEmail(event.target.value)}
              autoComplete="email"
            />
          </label>
          <label>
            <span>Senha</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button
            type="button"
            disabled={authBusy || !email || !password}
            onClick={() => void loginEmail()}
          >
            Entrar
          </button>
          {error ? <p className="remote-error">{error}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <div className="remote-shell">
      <header className="remote-topbar">
        <div>
          <span className="eyebrow">NESTLIVE · REMOTE MIX</span>
          <strong>{snapshot?.state.model ?? 'Console remota'}</strong>
        </div>
        <div className="remote-topbar__meta">
          <span className="pill">
            {status === 'online' ? '● Online' : status}
          </span>
          <span className="pill">
            {quality.rttMs === undefined
              ? quality.profile
              : `${Math.round(quality.rttMs)} ms · ${quality.profile}`}
          </span>
          <button type="button" onClick={() => void remoteSignOut()}>
            Sair
          </button>
        </div>
      </header>

      {error ? (
        <div className="remote-banner">{error}</div>
      ) : null}

      <div className="mix-layout">
        <main className="mix-layout__main">
          <header className="section-heading">
            <div>
              <span className="eyebrow">AO VIVO · REMOTO</span>
              <h1>Mix</h1>
            </div>
            <span className="pill">
              {grant?.role ?? 'autenticando'}
            </span>
          </header>

          {snapshot ? (
            <MixSurface
              channels={channels}
              selectedId={selectedId}
              onSelect={setSelectedId}
              stale={stale}
            />
          ) : (
            <div className="remote-loading">
              Sincronizando estado real da mesa…
            </div>
          )}
        </main>

        <ChannelInspector
          channel={selected}
          stale={stale}
          capabilities={capabilities}
          onCommand={runCommand}
          processingError="Processamento profundo remoto exige leitura dedicada do canal e permanece oculto nesta sessão."
        />
      </div>
    </div>
  );
}
