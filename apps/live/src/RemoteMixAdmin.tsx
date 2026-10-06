import { useEffect, useMemo, useState } from 'react';
import type { RemoteRelayScope } from '@millionsnest/nestlive-domain';
import type { NestLiveAudioApiClient } from './audioNodeApiClient';
import {
  observeRemoteUser,
  remoteEmailSignIn,
  remoteFirebaseConfigured,
  remoteGoogleSignIn,
  remoteSignOut,
  type RemoteFirebaseUser
} from './remoteAuth';

type Role = 'technical_admin' | 'operator' | 'viewer';

const ROLE_PERMISSIONS = {
  viewer: ['audio.read'],
  operator: [
    'audio.read',
    'audio.fader.write',
    'audio.mute.write',
    'audio.guarded.write'
  ],
  technical_admin: [
    'audio.read',
    'audio.fader.write',
    'audio.mute.write',
    'audio.guarded.write',
    'audio.critical.write'
  ]
} as const;

function relayHttpUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('remote_relay_url_invalid');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function buildRemoteLink(input: {
  publicBaseUrl: string;
  relayUrl: string;
  scope: RemoteRelayScope;
  grantToken: string;
}): string {
  const url = new URL('/remote', input.publicBaseUrl);
  url.searchParams.set('relay', input.relayUrl);
  url.searchParams.set('node', input.scope.nodeId);
  url.searchParams.set('org', input.scope.organizationId);
  url.searchParams.set('venue', input.scope.venueId);
  url.searchParams.set('live', input.scope.liveSystemId);
  url.hash = new URLSearchParams({
    grant: input.grantToken
  }).toString();
  return url.toString();
}

export function RemoteMixAdmin(props: {
  api?: NestLiveAudioApiClient;
  connected: boolean;
}) {
  const [user, setUser] = useState<RemoteFirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<Awaited<
    ReturnType<NestLiveAudioApiClient['session']>
  >>();
  const [remoteStatus, setRemoteStatus] = useState<Awaited<
    ReturnType<NestLiveAudioApiClient['remoteStatus']>
  >>();
  const [relayUrl, setRelayUrl] = useState(
    import.meta.env.VITE_NESTLIVE_RELAY_URL ?? ''
  );
  const [publicBaseUrl, setPublicBaseUrl] = useState(
    import.meta.env.VITE_NESTLIVE_PUBLIC_URL ??
      (window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost'
        ? 'https://live.millionsnest.com'
        : window.location.origin)
  );
  const [role, setRole] = useState<Role>('operator');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [generatedLink, setGeneratedLink] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [copied, setCopied] = useState(false);

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

  const refresh = async () => {
    if (!props.api || !props.connected) return;
    const [nextSession, nextStatus] = await Promise.all([
      props.api.session(),
      props.api.remoteStatus()
    ]);
    setSession(nextSession);
    setRemoteStatus(nextStatus);
  };

  useEffect(() => {
    if (!props.api || !props.connected) {
      setSession(undefined);
      setRemoteStatus(undefined);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const [nextSession, nextStatus] = await Promise.all([
          props.api!.session(),
          props.api!.remoteStatus()
        ]);
        if (!alive) return;
        setSession(nextSession);
        setRemoteStatus(nextStatus);
      } catch (caught) {
        if (alive) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'remote_status_failed'
          );
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [props.api, props.connected]);

  const scope = useMemo<RemoteRelayScope | undefined>(() => {
    const binding = session?.binding;
    if (!binding) return undefined;
    return {
      nodeId: binding.nodeId,
      organizationId: binding.organizationId,
      venueId: binding.venueId,
      liveSystemId: binding.liveSystemId
    };
  }, [session]);

  const activateRelay = async () => {
    if (!props.api || !scope || !user) return;
    setBusy('relay');
    setError(undefined);
    try {
      const idToken = await user.getIdToken(true);
      const httpUrl = relayHttpUrl(relayUrl);
      const response = await fetch(`${httpUrl}/v1/node-tickets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${idToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(scope)
      });
      const body = await response.json() as {
        ticket?: string;
        error?: string;
      };
      if (!response.ok || !body.ticket) {
        throw new Error(body.error ?? 'remote_ticket_failed');
      }
      await props.api.configureRemoteRelay({
        relayUrl: httpUrl,
        nodeTicket: body.ticket,
        scope
      });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'remote_relay_failed'
      );
    } finally {
      setBusy(undefined);
    }
  };

  const createAccess = async () => {
    if (!props.api || !scope || !user) return;
    setBusy('grant');
    setCopied(false);
    setError(undefined);
    try {
      const issued = await props.api.issueRemoteGrant({
        actorId: user.uid,
        role,
        permissions: [...ROLE_PERMISSIONS[role]],
        ttlMinutes
      });
      const link = buildRemoteLink({
        publicBaseUrl,
        relayUrl: relayHttpUrl(relayUrl),
        scope,
        grantToken: issued.token
      });
      setGeneratedLink(link);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'remote_grant_failed'
      );
    } finally {
      setBusy(undefined);
    }
  };

  const copy = async () => {
    if (!generatedLink) return;
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
  };

  if (!props.connected || !props.api) {
    return (
      <section className="remote-admin">
        <header className="section-heading">
          <div>
            <span className="eyebrow">REMOTE MIX</span>
            <h1>Acesso remoto seguro</h1>
          </div>
        </header>
        <div className="remote-admin__empty">
          Conecte este navegador ao NestLive Node para administrar o Remote Mix.
        </div>
      </section>
    );
  }

  return (
    <section className="remote-admin">
      <header className="section-heading">
        <div>
          <span className="eyebrow">REMOTE MIX</span>
          <h1>Acesso remoto seguro</h1>
        </div>
        <span className="pill">
          {remoteStatus?.tunnel.state ?? 'carregando'}
        </span>
      </header>

      <div className="remote-admin__grid">
        <article className="remote-admin__card">
          <span className="eyebrow">1 · IDENTIDADE</span>
          <h2>MillionsNest</h2>
          {!remoteFirebaseConfigured() ? (
            <p>
              O build ainda não recebeu as variáveis públicas do Firebase
              MillionsNest. O Remote Mix continua desativado.
            </p>
          ) : !authReady ? (
            <p>Verificando sessão…</p>
          ) : user ? (
            <div className="remote-admin__identity">
              <strong>{user.displayName || user.email || user.uid}</strong>
              <small>{user.email || user.uid}</small>
              <button type="button" onClick={() => void remoteSignOut()}>
                Trocar conta
              </button>
            </div>
          ) : (
            <div className="remote-admin__login">
              <button
                type="button"
                className="is-primary"
                disabled={authBusy}
                onClick={() => {
                  setAuthBusy(true);
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
              <input
                placeholder="E-mail"
                value={email}
                onChange={event => setEmail(event.target.value)}
                autoComplete="email"
              />
              <input
                placeholder="Senha"
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                disabled={authBusy || !email || !password}
                onClick={() => {
                  setAuthBusy(true);
                  void remoteEmailSignIn(email.trim(), password)
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
                Entrar
              </button>
            </div>
          )}
        </article>

        <article className="remote-admin__card">
          <span className="eyebrow">2 · RELAY</span>
          <h2>Conexão de saída</h2>
          <p>
            A mesa nunca recebe porta pública. O NestLive Node abre somente uma
            conexão autenticada de saída para o relay.
          </p>
          <label>
            <span>Relay público</span>
            <input
              value={relayUrl}
              placeholder="https://relay-live.millionsnest.com"
              onChange={event => setRelayUrl(event.target.value)}
            />
          </label>
          <div className="remote-admin__scope">
            <small>Node</small>
            <code>{scope?.nodeId ?? 'sem binding'}</code>
            <small>Venue</small>
            <code>{scope?.venueId ?? 'sem binding'}</code>
          </div>
          <div className="remote-admin__actions">
            <button
              type="button"
              className="is-primary"
              disabled={
                !user ||
                !scope ||
                !relayUrl ||
                busy === 'relay'
              }
              onClick={() => void activateRelay()}
            >
              {busy === 'relay'
                ? 'Conectando…'
                : remoteStatus?.tunnel.state === 'online'
                  ? 'Renovar conexão'
                  : 'Ativar Remote Mix'}
            </button>
            {remoteStatus?.tunnel.state !== 'disabled' ? (
              <button
                type="button"
                onClick={() => {
                  if (!props.api) return;
                  setBusy('disable');
                  void props.api
                    .disableRemoteRelay()
                    .then(refresh)
                    .finally(() => setBusy(undefined));
                }}
              >
                Desativar
              </button>
            ) : null}
          </div>
          {remoteStatus?.tunnel.lastError ? (
            <div className="remote-admin__warning">
              {remoteStatus.tunnel.lastError}
            </div>
          ) : null}
        </article>

        <article className="remote-admin__card remote-admin__card--wide">
          <span className="eyebrow">3 · ACESSO TEMPORÁRIO</span>
          <h2>Gerar link</h2>
          <div className="remote-admin__grant-form">
            <label>
              <span>Perfil</span>
              <select
                value={role}
                onChange={event => setRole(event.target.value as Role)}
              >
                <option value="viewer">Somente leitura</option>
                <option value="operator">Operador</option>
                <option value="technical_admin">Administrador técnico</option>
              </select>
            </label>
            <label>
              <span>Duração</span>
              <select
                value={ttlMinutes}
                onChange={event => setTtlMinutes(Number(event.target.value))}
              >
                <option value={15}>15 minutos</option>
                <option value={30}>30 minutos</option>
                <option value={60}>1 hora</option>
                <option value={120}>2 horas</option>
                <option value={240}>4 horas</option>
              </select>
            </label>
            <label className="remote-admin__public-url">
              <span>URL pública do NestLive</span>
              <input
                value={publicBaseUrl}
                onChange={event => setPublicBaseUrl(event.target.value)}
              />
            </label>
          </div>
          <div className="remote-admin__permissions">
            {ROLE_PERMISSIONS[role].map(permission => (
              <span className="pill" key={permission}>
                {permission}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="is-primary"
            disabled={
              !user ||
              !scope ||
              remoteStatus?.tunnel.state !== 'online' ||
              busy === 'grant'
            }
            onClick={() => void createAccess()}
          >
            {busy === 'grant' ? 'Gerando…' : 'Gerar link temporário'}
          </button>

          {generatedLink ? (
            <div className="remote-admin__generated">
              <strong>Link criado</strong>
              <code>{generatedLink}</code>
              <div>
                <button type="button" onClick={() => void copy()}>
                  {copied ? 'Copiado' : 'Copiar link'}
                </button>
                {'share' in navigator ? (
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.share({
                        title: 'NestLive Remote Mix',
                        url: generatedLink
                      })
                    }
                  >
                    Compartilhar
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </article>

        <article className="remote-admin__card remote-admin__card--wide">
          <div className="remote-admin__card-header">
            <div>
              <span className="eyebrow">SESSÕES</span>
              <h2>Grants ativos</h2>
            </div>
            <span className="pill">
              {remoteStatus?.grants.length ?? 0}
            </span>
          </div>
          <div className="remote-admin__grants">
            {(remoteStatus?.grants ?? []).length === 0 ? (
              <p>Nenhum acesso remoto ativo.</p>
            ) : (
              remoteStatus!.grants.map(grant => (
                <div className="remote-admin__grant" key={grant.id}>
                  <div>
                    <strong>{grant.role}</strong>
                    <small>{grant.actorId}</small>
                    <small>
                      expira{' '}
                      {new Date(grant.expiresAt).toLocaleString('pt-BR')}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="is-critical"
                    onClick={() => {
                      if (!props.api) return;
                      setBusy(grant.id);
                      void props.api
                        .revokeRemoteGrant(grant.id)
                        .then(refresh)
                        .finally(() => setBusy(undefined));
                    }}
                    disabled={busy === grant.id}
                  >
                    Revogar
                  </button>
                </div>
              ))
            )}
          </div>
        </article>
      </div>

      {error ? <div className="remote-banner">{error}</div> : null}
    </section>
  );
}
