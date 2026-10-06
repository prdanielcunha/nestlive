import type {
  RemoteMixGrant,
  RemoteRelayIdentity,
  RemoteRelayScope
} from '@millionsnest/nestlive-domain';

export interface RelaySocket {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayNodeConnection {
  id: string;
  identity: RemoteRelayIdentity;
  scope: RemoteRelayScope;
  socket: RelaySocket;
  connectedAt: string;
}

export interface RelayClientConnection {
  id: string;
  identity: RemoteRelayIdentity;
  scope: RemoteRelayScope;
  socket: RelaySocket;
  connectedAt: string;
  grant?: RemoteMixGrant;
  nodeId?: string;
}

function key(scope: RemoteRelayScope): string {
  return [
    scope.organizationId,
    scope.venueId,
    scope.liveSystemId,
    scope.nodeId
  ].join(':');
}

export class RemoteRelayRegistry {
  private readonly nodes = new Map<string, RelayNodeConnection>();
  private readonly clients = new Map<string, RelayClientConnection>();

  registerNode(node: RelayNodeConnection): RelayNodeConnection | undefined {
    const k = key(node.scope);
    const previous = this.nodes.get(k);
    this.nodes.set(k, node);
    return previous;
  }

  nodeForScope(scope: RemoteRelayScope): RelayNodeConnection | undefined {
    return this.nodes.get(key(scope));
  }

  removeNode(id: string): RelayClientConnection[] {
    const entry = [...this.nodes.entries()].find(
      ([, node]) => node.id === id
    );
    if (!entry) return [];
    this.nodes.delete(entry[0]);

    const detached: RelayClientConnection[] = [];
    for (const client of this.clients.values()) {
      if (client.nodeId === id) {
        client.nodeId = undefined;
        client.grant = undefined;
        detached.push(client);
      }
    }
    return detached;
  }

  registerClient(client: RelayClientConnection): void {
    this.clients.set(client.id, client);
  }

  authenticateClient(input: {
    clientId: string;
    nodeId: string;
    grant: RemoteMixGrant;
  }): RelayClientConnection {
    const client = this.clients.get(input.clientId);
    if (!client) throw new Error('remote_relay_client_missing');
    client.nodeId = input.nodeId;
    client.grant = { ...input.grant, permissions: [...input.grant.permissions] };
    return client;
  }

  client(id: string): RelayClientConnection | undefined {
    return this.clients.get(id);
  }

  removeClient(id: string): RelayClientConnection | undefined {
    const client = this.clients.get(id);
    this.clients.delete(id);
    return client;
  }

  clientsForNode(nodeId: string): RelayClientConnection[] {
    return [...this.clients.values()].filter(
      client => client.nodeId === nodeId
    );
  }

  counts(): { nodes: number; clients: number; authenticatedClients: number } {
    const clients = [...this.clients.values()];
    return {
      nodes: this.nodes.size,
      clients: clients.length,
      authenticatedClients: clients.filter(client => client.grant).length
    };
  }
}
