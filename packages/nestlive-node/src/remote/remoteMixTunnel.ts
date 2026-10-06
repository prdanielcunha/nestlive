import { WebSocket } from 'ws';
import {
  canUseRemoteCapability,
  capabilityForAudioCommand,
  meterProfileTargetFps,
  type RemoteMeterProfile,
  type RemoteMixGrant,
  type RemoteRelayScope,
  type RemoteRelayServerMessage
} from '@millionsnest/nestlive-domain';
import type { NestLiveAudioRuntime } from '../audio/audioRuntime';
import type { RemoteMixAuthority } from './remoteMixAuthority';

export interface RemoteMixTunnelConfig {
  relayUrl: string;
  nodeTicket: string;
  scope: RemoteRelayScope;
}

export interface RemoteMixTunnelStatus {
  state: 'disabled' | 'connecting' | 'online' | 'offline';
  relayUrl?: string;
  sessions: number;
  lastConnectedAt?: string;
  lastError?: string;
}

interface RemoteSession {
  grant: RemoteMixGrant;
  profile: RemoteMeterProfile;
  visible: boolean;
  lastMeterSentAt: number;
}

function safeRelayUrl(value: string): string {
  const url = new URL(value);
  if (!['wss:', 'ws:'].includes(url.protocol)) {
    throw new Error('remote_relay_url_protocol_invalid');
  }
  if (
    url.protocol === 'ws:' &&
    !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  ) {
    throw new Error('remote_relay_requires_tls');
  }
  url.pathname = '/v1/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function normalizeRemoteProfile(
  profile: RemoteMeterProfile,
  visible: boolean
): RemoteMeterProfile {
  if (!visible) return 'off';
  if (profile === 'lan_full') return 'remote_high';
  return profile;
}

export class RemoteMixTunnelClient {
  private socket?: WebSocket;
  private config?: RemoteMixTunnelConfig;
  private reconnectTimer?: NodeJS.Timeout;
  private meterTimer?: NodeJS.Timeout;
  private stopped = true;
  private sessions = new Map<string, RemoteSession>();
  private lastMeterKey?: string;
  private currentStatus: RemoteMixTunnelStatus = {
    state: 'disabled',
    sessions: 0
  };

  constructor(
    private readonly authority: RemoteMixAuthority,
    private readonly runtime: NestLiveAudioRuntime,
    private readonly selectMeterProvider: () => string | undefined
  ) {}

  status(): RemoteMixTunnelStatus {
    return {
      ...this.currentStatus,
      sessions: this.sessions.size
    };
  }

  async configure(config: RemoteMixTunnelConfig): Promise<void> {
    const normalized: RemoteMixTunnelConfig = {
      ...config,
      relayUrl: safeRelayUrl(config.relayUrl)
    };
    if (
      !normalized.nodeTicket.trim() ||
      !normalized.scope.nodeId ||
      !normalized.scope.organizationId ||
      !normalized.scope.venueId ||
      !normalized.scope.liveSystemId
    ) {
      throw new Error('remote_relay_config_incomplete');
    }

    this.config = normalized;
    this.stopped = false;
    this.sessions.clear();
    this.clearReconnect();
    this.closeSocket();
    this.ensureMeterPump();
    this.connect();
  }

  async disable(): Promise<void> {
    this.stopped = true;
    this.config = undefined;
    this.sessions.clear();
    this.clearReconnect();
    this.closeSocket();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    this.currentStatus = {
      state: 'disabled',
      sessions: 0
    };
  }

  private connect(): void {
    const config = this.config;
    if (!config || this.stopped) return;

    this.currentStatus = {
      ...this.currentStatus,
      state: 'connecting',
      relayUrl: config.relayUrl,
      lastError: undefined
    };

    const socket = new WebSocket(config.relayUrl, {
      handshakeTimeout: 5000,
      perMessageDeflate: false,
      maxPayload: 256 * 1024
    });
    this.socket = socket;

    socket.on('open', () => {
      this.send({
        type: 'node.hello',
        ticket: config.nodeTicket
      });
    });
    socket.on('message', data => {
      void this.handleMessage(data.toString()).catch(error => {
        this.currentStatus = {
          ...this.currentStatus,
          lastError:
            error instanceof Error ? error.message : 'remote_message_failed'
        };
      });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.sessions.clear();
      if (!this.stopped && this.config) {
        this.currentStatus = {
          ...this.currentStatus,
          state: 'offline',
          sessions: 0
        };
        this.scheduleReconnect();
      }
    });
    socket.on('error', error => {
      this.currentStatus = {
        ...this.currentStatus,
        lastError: error.message
      };
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const message = JSON.parse(raw) as RemoteRelayServerMessage;
    const config = this.config;
    if (!config) return;

    if (message.type === 'relay.node-online') {
      if (
        JSON.stringify(message.scope) !== JSON.stringify(config.scope)
      ) {
        throw new Error('remote_relay_scope_mismatch');
      }
      this.currentStatus = {
        state: 'online',
        relayUrl: config.relayUrl,
        sessions: this.sessions.size,
        lastConnectedAt: new Date().toISOString()
      };
      return;
    }

    if (message.type === 'relay.client-auth') {
      const grant = await this.authority.authenticate(
        message.grantToken
      );
      const accepted =
        Boolean(grant) &&
        grant!.actorId === message.identity.uid &&
        grant!.organizationId === message.scope.organizationId &&
        grant!.venueId === message.scope.venueId &&
        grant!.liveSystemId === message.scope.liveSystemId &&
        message.scope.nodeId === config.scope.nodeId &&
        message.scope.organizationId === config.scope.organizationId &&
        message.scope.venueId === config.scope.venueId &&
        message.scope.liveSystemId === config.scope.liveSystemId;

      if (accepted && grant) {
        this.sessions.set(message.clientId, {
          grant,
          profile: 'remote_medium',
          visible: true,
          lastMeterSentAt: 0
        });
      }

      this.send({
        type: 'node.client-auth-result',
        requestId: message.requestId,
        accepted,
        grant: accepted ? grant : undefined,
        reason: accepted ? undefined : 'grant_or_scope_rejected'
      });
      return;
    }

    if (message.type === 'relay.client-detached') {
      this.sessions.delete(message.clientId);
      return;
    }

    if (message.type === 'relay.meter-profile') {
      const session = this.sessions.get(message.clientId);
      if (!session) return;
      session.profile = normalizeRemoteProfile(
        message.profile,
        message.visible
      );
      session.visible = message.visible;
      return;
    }

    if (message.type === 'relay.snapshot') {
      const session = this.sessions.get(message.clientId);
      if (!session?.grant.permissions.includes('audio.read')) {
        this.send({
          type: 'node.snapshot-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error: 'remote_permission_denied'
        });
        return;
      }

      const providerInstanceId = this.selectMeterProvider();
      if (
        !providerInstanceId ||
        !this.runtime.hasProvider(providerInstanceId)
      ) {
        this.send({
          type: 'node.snapshot-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error: 'audio_provider_offline'
        });
        return;
      }

      try {
        const provider = this.runtime.getProvider(providerInstanceId);
        const [state, channels] = await Promise.all([
          provider.getConsoleState(),
          provider.getChannels()
        ]);
        this.send({
          type: 'node.snapshot-result',
          clientId: message.clientId,
          requestId: message.requestId,
          snapshot: {
            providerInstanceId,
            capabilities: [...provider.capabilities()],
            state,
            channels
          }
        });
      } catch (error) {
        this.send({
          type: 'node.snapshot-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error:
            error instanceof Error
              ? error.message
              : 'remote_snapshot_failed'
        });
      }
      return;
    }

    if (message.type === 'relay.command') {
      const session = this.sessions.get(message.clientId);
      if (!session) {
        this.send({
          type: 'node.command-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error: 'remote_session_missing'
        });
        return;
      }

      const envelope = message.envelope;
      const capability = capabilityForAudioCommand(envelope.command);
      if (
        envelope.actorId !== session.grant.actorId ||
        !canUseRemoteCapability(session.grant, capability) ||
        !this.runtime.hasProvider(envelope.providerInstanceId)
      ) {
        this.send({
          type: 'node.command-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error: 'remote_permission_denied'
        });
        return;
      }

      try {
        const execution = await this.runtime.execute(envelope);
        this.send({
          type: 'node.command-result',
          clientId: message.clientId,
          requestId: message.requestId,
          execution
        });
      } catch (error) {
        this.send({
          type: 'node.command-result',
          clientId: message.clientId,
          requestId: message.requestId,
          error:
            error instanceof Error
              ? error.message
              : 'remote_command_failed'
        });
      }
      return;
    }

    if (message.type === 'relay.ping') {
      this.send({
        type: 'node.pong',
        clientId: message.clientId,
        sentAt: message.sentAt,
        receivedAt: Date.now()
      });
      return;
    }

    if (message.type === 'relay.error') {
      this.currentStatus = {
        ...this.currentStatus,
        lastError: message.code
      };
    }
  }

  private ensureMeterPump(): void {
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => {
      if (
        this.currentStatus.state !== 'online' ||
        this.sessions.size === 0
      ) {
        return;
      }
      const providerId = this.selectMeterProvider();
      if (!providerId || !this.runtime.hasProvider(providerId)) return;
      const frame = this.runtime.latestMeter(providerId);
      if (!frame) return;
      const frameKey = `${providerId}:${frame.sequence}`;
      if (frameKey === this.lastMeterKey) return;
      this.lastMeterKey = frameKey;

      const now = Date.now();
      for (const [clientId, session] of this.sessions) {
        const profile = normalizeRemoteProfile(
          session.profile,
          session.visible
        );
        const fps = meterProfileTargetFps(profile);
        if (fps <= 0) continue;
        if (now - session.lastMeterSentAt < 1000 / fps) continue;

        session.lastMeterSentAt = now;
        this.send({
          type: 'node.meter',
          clientId,
          frame
        });
      }
    }, 16);
    this.meterTimer.unref();
  }

  private send(message: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 2000 + Math.floor(Math.random() * 1000));
    this.reconnectTimer.unref();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, 'reconfigured');
    }
  }
}
