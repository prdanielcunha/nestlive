import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  canUseRemoteCapability,
  capabilityForAudioCommand,
  type RemoteMixGrant,
  type RemoteRelayClientMessage,
  type RemoteRelayNodeMessage,
  type RemoteRelayScope,
  type RemoteRelayServerMessage
} from '@millionsnest/nestlive-domain';
import type {
  RelayIdentityVerifier,
  RelayScopeAuthorizer,
  RelayVerifiedIdentity
} from './identity';
import { RemoteRelayRegistry } from './registry';
import { RelayTicketSigner } from './tickets';

interface PendingClientAuth {
  requestId: string;
  clientId: string;
  nodeId: string;
  identity: RelayVerifiedIdentity;
  scope: RemoteRelayScope;
  createdAt: number;
}

type SocketRole =
  | { kind: 'unknown'; connectionId: string }
  | { kind: 'node'; connectionId: string; nodeId: string }
  | { kind: 'client-pending'; connectionId: string; clientId: string }
  | { kind: 'client'; connectionId: string; clientId: string };

export interface RemoteRelayServerOptions {
  host?: string;
  port: number;
  identityVerifier: RelayIdentityVerifier;
  scopeAuthorizer: RelayScopeAuthorizer;
  ticketSigner: RelayTicketSigner;
  authTimeoutMs?: number;
}

function json(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(payload);
}

async function readJson(
  request: http.IncomingMessage,
  limit = 64 * 1024
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bearer(request: http.IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length).trim() || undefined;
}

function send(socket: WebSocket, message: RemoteRelayServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function scopeMatches(
  grant: RemoteMixGrant,
  scope: RemoteRelayScope,
  identityUid: string
): boolean {
  return (
    grant.actorId === identityUid &&
    grant.organizationId === scope.organizationId &&
    grant.venueId === scope.venueId &&
    grant.liveSystemId === scope.liveSystemId &&
    !grant.revokedAt &&
    new Date(grant.expiresAt).getTime() > Date.now()
  );
}

export class RemoteRelayServer {
  private readonly httpServer: http.Server;
  private readonly wsServer: WebSocketServer;
  private readonly registry = new RemoteRelayRegistry();
  private readonly roles = new Map<WebSocket, SocketRole>();
  private readonly pending = new Map<string, PendingClientAuth>();
  private readonly authTimers = new Map<WebSocket, NodeJS.Timeout>();

  constructor(private readonly options: RemoteRelayServerOptions) {
    this.httpServer = http.createServer((request, response) => {
      void this.handleHttp(request, response).catch(error => {
        json(response, 500, {
          error: error instanceof Error ? error.message : 'internal_error'
        });
      });
    });

    this.wsServer = new WebSocketServer({
      noServer: true,
      maxPayload: 256 * 1024,
      perMessageDeflate: false
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://relay.local');
      if (url.pathname !== '/v1/ws') {
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, ws => {
        this.wsServer.emit('connection', ws, request);
      });
    });

    this.wsServer.on('connection', socket => this.attach(socket));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(
        this.options.port,
        this.options.host ?? '0.0.0.0',
        () => resolve()
      );
    });
  }

  address(): { port: number } {
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('remote_relay_not_listening');
    }
    return { port: address.port };
  }

  async close(): Promise<void> {
    for (const timer of this.authTimers.values()) clearTimeout(timer);
    this.authTimers.clear();
    for (const socket of this.roles.keys()) {
      socket.close(1001, 'relay_shutdown');
    }
    await new Promise<void>(resolve =>
      this.wsServer.close(() => resolve())
    );
    await new Promise<void>((resolve, reject) =>
      this.httpServer.close(error => (error ? reject(error) : resolve()))
    );
  }

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://relay.local');

    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, {
        ok: true,
        ...this.registry.counts()
      });
      return;
    }

    if (
      request.method === 'POST' &&
      url.pathname === '/v1/node-tickets'
    ) {
      const token = bearer(request);
      if (!token) {
        json(response, 401, { error: 'firebase_bearer_required' });
        return;
      }
      const identity =
        await this.options.identityVerifier.verifyIdToken(token);
      const body = (await readJson(request)) as {
        nodeId?: string;
        organizationId?: string;
        venueId?: string;
        liveSystemId?: string;
      };
      const scope: RemoteRelayScope = {
        nodeId: String(body.nodeId ?? '').trim(),
        organizationId: String(body.organizationId ?? '').trim(),
        venueId: String(body.venueId ?? '').trim(),
        liveSystemId: String(body.liveSystemId ?? '').trim()
      };
      if (Object.values(scope).some(value => !value)) {
        json(response, 400, { error: 'scope_incomplete' });
        return;
      }
      if (
        !(await this.options.scopeAuthorizer.authorize(identity, scope))
      ) {
        json(response, 403, { error: 'scope_forbidden' });
        return;
      }

      json(response, 201, {
        ticket: this.options.ticketSigner.issueNodeTicket({
          identity,
          scope
        }),
        expiresInSeconds: 300
      });
      return;
    }

    json(response, 404, { error: 'not_found' });
  }

  private attach(socket: WebSocket): void {
    const connectionId = randomUUID();
    this.roles.set(socket, { kind: 'unknown', connectionId });
    send(socket, { type: 'relay.ready', connectionId });

    const timer = setTimeout(() => {
      if (this.roles.get(socket)?.kind === 'unknown') {
        socket.close(4401, 'authentication_timeout');
      }
    }, this.options.authTimeoutMs ?? 5000);
    this.authTimers.set(socket, timer);

    socket.on('message', data => {
      void this.handleMessage(socket, data.toString()).catch(error => {
        send(socket, {
          type: 'relay.error',
          code: 'message_rejected',
          message:
            error instanceof Error ? error.message : 'unknown_error'
        });
      });
    });
    socket.on('close', () => this.detach(socket));
    socket.on('error', () => this.detach(socket));
  }

  private async handleMessage(
    socket: WebSocket,
    raw: string
  ): Promise<void> {
    if (Buffer.byteLength(raw) > 256 * 1024) {
      socket.close(1009, 'message_too_large');
      return;
    }

    const message = JSON.parse(raw) as
      | RemoteRelayClientMessage
      | RemoteRelayNodeMessage;
    const role = this.roles.get(socket);
    if (!role) return;

    if (role.kind === 'unknown') {
      if (message.type === 'node.hello') {
        this.authenticateNode(socket, role.connectionId, message.ticket);
        return;
      }
      if (message.type === 'client.hello') {
        await this.beginClientAuthentication(
          socket,
          role.connectionId,
          message
        );
        return;
      }
      throw new Error('hello_required');
    }

    if (role.kind === 'node') {
      this.handleNodeMessage(role.nodeId, message as RemoteRelayNodeMessage);
      return;
    }

    if (role.kind === 'client-pending') {
      throw new Error('client_authentication_pending');
    }

    this.handleClientMessage(
      role.clientId,
      message as RemoteRelayClientMessage
    );
  }

  private authenticateNode(
    socket: WebSocket,
    connectionId: string,
    ticket: string
  ): void {
    const claims = this.options.ticketSigner.verifyNodeTicket(ticket);
    const previous = this.registry.registerNode({
      id: connectionId,
      identity: claims.identity,
      scope: claims.scope,
      socket,
      connectedAt: new Date().toISOString()
    });
    if (previous && previous.id !== connectionId) {
      previous.socket.close(4409, 'node_replaced');
    }

    this.roles.set(socket, {
      kind: 'node',
      connectionId,
      nodeId: connectionId
    });
    this.clearAuthTimer(socket);
    send(socket, {
      type: 'relay.node-online',
      scope: claims.scope
    });
  }

  private async beginClientAuthentication(
    socket: WebSocket,
    connectionId: string,
    hello: Extract<RemoteRelayClientMessage, { type: 'client.hello' }>
  ): Promise<void> {
    const identity =
      await this.options.identityVerifier.verifyIdToken(hello.idToken);
    if (
      !(await this.options.scopeAuthorizer.authorize(
        identity,
        hello.scope
      ))
    ) {
      socket.close(4403, 'scope_forbidden');
      return;
    }

    const node = this.registry.nodeForScope(hello.scope);
    if (!node) {
      send(socket, {
        type: 'relay.denied',
        reason: 'node_offline'
      });
      socket.close(4410, 'node_offline');
      return;
    }

    const clientId = connectionId;
    this.registry.registerClient({
      id: clientId,
      identity,
      scope: hello.scope,
      socket,
      connectedAt: new Date().toISOString()
    });
    this.roles.set(socket, {
      kind: 'client-pending',
      connectionId,
      clientId
    });
    this.clearAuthTimer(socket);

    const requestId = randomUUID();
    this.pending.set(requestId, {
      requestId,
      clientId,
      nodeId: node.id,
      identity,
      scope: hello.scope,
      createdAt: Date.now()
    });

    send(node.socket as WebSocket, {
      type: 'relay.client-auth',
      requestId,
      clientId,
      identity,
      grantToken: hello.grantToken,
      scope: hello.scope
    });
  }

  private handleNodeMessage(
    nodeId: string,
    message: RemoteRelayNodeMessage
  ): void {
    if (message.type === 'node.client-auth-result') {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.nodeId !== nodeId) return;
      this.pending.delete(message.requestId);

      const client = this.registry.client(pending.clientId);
      if (!client) return;
      const socket = client.socket as WebSocket;

      if (
        !message.accepted ||
        !message.grant ||
        !scopeMatches(
          message.grant,
          pending.scope,
          pending.identity.uid
        )
      ) {
        send(socket, {
          type: 'relay.denied',
          reason: message.reason ?? 'grant_rejected'
        });
        socket.close(4403, 'grant_rejected');
        return;
      }

      this.registry.authenticateClient({
        clientId: pending.clientId,
        nodeId,
        grant: message.grant
      });
      const role = this.roles.get(socket);
      if (role) {
        this.roles.set(socket, {
          kind: 'client',
          connectionId: role.connectionId,
          clientId: pending.clientId
        });
      }
      send(socket, {
        type: 'relay.authenticated',
        clientId: pending.clientId,
        grant: message.grant
      });
      return;
    }

    if (
      message.type === 'node.command-result' ||
      message.type === 'node.meter' ||
      message.type === 'node.pong'
    ) {
      const client = this.registry.client(message.clientId);
      if (!client || client.nodeId !== nodeId) return;
      const socket = client.socket as WebSocket;

      if (message.type === 'node.command-result') {
        send(socket, {
          type: 'relay.command-result',
          requestId: message.requestId,
          execution: message.execution,
          error: message.error
        });
      } else if (message.type === 'node.meter') {
        if (client.grant?.permissions.includes('audio.read')) {
          send(socket, {
            type: 'relay.meter',
            frame: message.frame
          });
        }
      } else {
        send(socket, {
          type: 'relay.pong',
          sentAt: message.sentAt,
          receivedAt: message.receivedAt
        });
      }
    }
  }

  private handleClientMessage(
    clientId: string,
    message: RemoteRelayClientMessage
  ): void {
    const client = this.registry.client(clientId);
    if (!client?.nodeId || !client.grant) {
      throw new Error('client_not_authenticated');
    }
    const target = this.registry.node(client.nodeId);
    if (!target) throw new Error('node_offline');

    if (message.type === 'client.command') {
      if (message.envelope.actorId !== client.identity.uid) {
        throw new Error('actor_mismatch');
      }
      const capability = capabilityForAudioCommand(
        message.envelope.command
      );
      if (!canUseRemoteCapability(client.grant, capability)) {
        send(client.socket as WebSocket, {
          type: 'relay.command-result',
          requestId: message.requestId,
          error: 'remote_permission_denied'
        });
        return;
      }
      send(target.socket as WebSocket, {
        type: 'relay.command',
        clientId,
        requestId: message.requestId,
        envelope: message.envelope
      });
      return;
    }

    if (message.type === 'client.meter-profile') {
      if (!client.grant.permissions.includes('audio.read')) return;
      send(target.socket as WebSocket, {
        type: 'relay.meter-profile',
        clientId,
        profile: message.profile,
        visible: message.visible
      });
      return;
    }

    if (message.type === 'client.ping') {
      send(target.socket as WebSocket, {
        type: 'relay.ping',
        clientId,
        sentAt: message.sentAt
      });
    }
  }

  private detach(socket: WebSocket): void {
    this.clearAuthTimer(socket);
    const role = this.roles.get(socket);
    this.roles.delete(socket);
    if (!role) return;

    if (role.kind === 'node') {
      const clients = this.registry.removeNode(role.nodeId);
      for (const client of clients) {
        send(client.socket as WebSocket, {
          type: 'relay.error',
          code: 'node_offline'
        });
        client.socket.close(1012, 'node_offline');
      }
      return;
    }

    if (
      role.kind === 'client' ||
      role.kind === 'client-pending'
    ) {
      const client = this.registry.removeClient(role.clientId);
      if (!client?.nodeId) return;
      const node = this.registry.node(client.nodeId);
      if (node) {
        send(node.socket as WebSocket, {
          type: 'relay.client-detached',
          clientId: role.clientId
        });
      }
    }
  }

  private clearAuthTimer(socket: WebSocket): void {
    const timer = this.authTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.authTimers.delete(socket);
  }
}
