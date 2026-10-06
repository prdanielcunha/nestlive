import {
  selectRemoteMeterProfile,
  type AudioCommandEnvelope,
  type AudioCommandExecution,
  type AudioControlCommand,
  type AudioSafetyLevel,
  type MeterFrame,
  type RemoteMeterProfile,
  type RemoteMixGrant,
  type RemoteRelayScope,
  type RemoteRelayServerMessage
} from '@millionsnest/nestlive-domain';

export interface RemoteAudioSnapshot {
  providerInstanceId: string;
  capabilities: string[];
  state: {
    providerInstanceId: string;
    model?: string;
    firmware?: string;
    connected: boolean;
    updatedAt: number;
    observed?: Record<string, unknown>;
  };
  channels: Array<{
    id: string;
    name: string;
    index: number;
    faderDb?: number;
    mute?: boolean;
    pan?: number;
    gainDb?: number;
    phantom?: boolean;
    metadata?: Record<string, unknown>;
  }>;
}

export interface RemoteRelayClientOptions {
  relayUrl: string;
  idToken: string;
  grantToken: string;
  scope: RemoteRelayScope;
  onStatus?: (
    status:
      | 'connecting'
      | 'authenticating'
      | 'online'
      | 'offline'
  ) => void;
  onGrant?: (grant: RemoteMixGrant) => void;
  onSnapshot?: (snapshot: RemoteAudioSnapshot) => void;
  onMeter?: (frame: MeterFrame) => void;
  onQuality?: (quality: { rttMs?: number; profile: RemoteMeterProfile }) => void;
  onError?: (error: string) => void;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function relayWebSocketUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['wss:', 'ws:'].includes(url.protocol)) {
    throw new Error('remote_relay_url_invalid');
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

export class RemoteMixWebSocketClient {
  private socket?: WebSocket;
  private grant?: RemoteMixGrant;
  private providerInstanceId?: string;
  private snapshotPending = new Map<string, Pending<RemoteAudioSnapshot>>();
  private commandPending = new Map<string, Pending<AudioCommandExecution>>();
  private pingTimer?: number;
  private lastRttMs?: number;
  private visible = document.visibilityState === 'visible';
  private currentProfile: RemoteMeterProfile = 'off';
  private readonly visibilityListener = () => {
    this.visible = document.visibilityState === 'visible';
    this.updateMeterProfile();
  };

  constructor(private readonly options: RemoteRelayClientOptions) {}

  connect(): void {
    this.options.onStatus?.('connecting');
    const socket = new WebSocket(
      relayWebSocketUrl(this.options.relayUrl)
    );
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.options.onStatus?.('authenticating');
      this.send({
        type: 'client.hello',
        idToken: this.options.idToken,
        grantToken: this.options.grantToken,
        scope: this.options.scope
      });
    });

    socket.addEventListener('message', event => {
      this.handle(String(event.data));
    });
    socket.addEventListener('close', () => {
      this.stopPing();
      this.options.onStatus?.('offline');
      this.rejectAll('remote_connection_closed');
    });
    socket.addEventListener('error', () => {
      this.options.onError?.('remote_connection_error');
    });

    document.addEventListener(
      'visibilitychange',
      this.visibilityListener
    );
  }

  disconnect(): void {
    document.removeEventListener(
      'visibilitychange',
      this.visibilityListener
    );
    this.stopPing();
    this.rejectAll('remote_disconnected');
    this.socket?.close(1000, 'client_disconnected');
    this.socket = undefined;
  }

  async snapshot(): Promise<RemoteAudioSnapshot> {
    const requestId = crypto.randomUUID();
    return new Promise<RemoteAudioSnapshot>((resolve, reject) => {
      this.snapshotPending.set(requestId, { resolve, reject });
      this.send({ type: 'client.snapshot', requestId });
      window.setTimeout(() => {
        const pending = this.snapshotPending.get(requestId);
        if (!pending) return;
        this.snapshotPending.delete(requestId);
        pending.reject(new Error('remote_snapshot_timeout'));
      }, 5000);
    });
  }

  async command(input: {
    actorId: string;
    command: AudioControlCommand;
    confirmedSafetyLevel?: AudioSafetyLevel;
  }): Promise<AudioCommandExecution> {
    if (!this.providerInstanceId) {
      throw new Error('remote_provider_not_loaded');
    }
    const requestId = crypto.randomUUID();
    const envelope: AudioCommandEnvelope = {
      id: crypto.randomUUID(),
      actorId: input.actorId,
      providerInstanceId: this.providerInstanceId,
      createdAt: new Date().toISOString(),
      command: input.command,
      confirmedSafetyLevel: input.confirmedSafetyLevel
    };

    return new Promise<AudioCommandExecution>((resolve, reject) => {
      this.commandPending.set(requestId, { resolve, reject });
      this.send({
        type: 'client.command',
        requestId,
        envelope
      });
      window.setTimeout(() => {
        const pending = this.commandPending.get(requestId);
        if (!pending) return;
        this.commandPending.delete(requestId);
        pending.reject(new Error('remote_command_timeout'));
      }, 5000);
    });
  }

  private handle(raw: string): void {
    let message: RemoteRelayServerMessage;
    try {
      message = JSON.parse(raw) as RemoteRelayServerMessage;
    } catch {
      this.options.onError?.('remote_invalid_message');
      return;
    }

    if (message.type === 'relay.authenticated') {
      this.grant = message.grant;
      this.options.onGrant?.(message.grant);
      this.options.onStatus?.('online');
      this.startPing();
      void this.snapshot()
        .then(snapshot => {
          this.providerInstanceId = snapshot.providerInstanceId;
          this.options.onSnapshot?.(snapshot);
          this.updateMeterProfile();
        })
        .catch(error =>
          this.options.onError?.(
            error instanceof Error
              ? error.message
              : 'remote_snapshot_failed'
          )
        );
      return;
    }

    if (message.type === 'relay.denied') {
      this.options.onError?.(message.reason);
      this.options.onStatus?.('offline');
      return;
    }

    if (message.type === 'relay.snapshot-result') {
      const pending = this.snapshotPending.get(message.requestId);
      if (!pending) return;
      this.snapshotPending.delete(message.requestId);
      if (message.error || !message.snapshot) {
        pending.reject(
          new Error(message.error ?? 'remote_snapshot_missing')
        );
      } else {
        pending.resolve(
          message.snapshot as RemoteAudioSnapshot
        );
      }
      return;
    }

    if (message.type === 'relay.command-result') {
      const pending = this.commandPending.get(message.requestId);
      if (!pending) return;
      this.commandPending.delete(message.requestId);
      if (message.error || !message.execution) {
        pending.reject(
          new Error(message.error ?? 'remote_command_failed')
        );
      } else {
        pending.resolve(message.execution);
      }
      return;
    }

    if (message.type === 'relay.meter') {
      this.options.onMeter?.(message.frame);
      return;
    }

    if (message.type === 'relay.pong') {
      this.lastRttMs = Math.max(0, Date.now() - message.sentAt);
      this.updateMeterProfile();
      return;
    }

    if (message.type === 'relay.error') {
      this.options.onError?.(message.code);
    }
  }

  private startPing(): void {
    this.stopPing();
    const ping = () =>
      this.send({
        type: 'client.ping',
        sentAt: Date.now()
      });
    ping();
    this.pingTimer = window.setInterval(ping, 5000);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      window.clearInterval(this.pingTimer);
    }
    this.pingTimer = undefined;
  }

  private updateMeterProfile(): void {
    if (!this.grant?.permissions.includes('audio.read')) {
      this.currentProfile = 'off';
    } else if (this.lastRttMs === undefined) {
      this.currentProfile = this.visible
        ? 'remote_medium'
        : 'off';
    } else {
      this.currentProfile = selectRemoteMeterProfile({
        local: false,
        rttMs: this.lastRttMs,
        packetLossPercent: 0,
        visible: this.visible
      });
    }

    this.send({
      type: 'client.meter-profile',
      profile: this.currentProfile,
      visible: this.visible
    });
    this.options.onQuality?.({
      rttMs: this.lastRttMs,
      profile: this.currentProfile
    });
  }

  private send(value: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(value));
  }

  private rejectAll(reason: string): void {
    const error = new Error(reason);
    for (const pending of this.snapshotPending.values()) {
      pending.reject(error);
    }
    for (const pending of this.commandPending.values()) {
      pending.reject(error);
    }
    this.snapshotPending.clear();
    this.commandPending.clear();
  }
}
