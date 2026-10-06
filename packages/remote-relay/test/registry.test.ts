import { describe, expect, it, vi } from 'vitest';
import { RemoteRelayRegistry } from '../src';

const scope = {
  nodeId: 'node-1',
  organizationId: 'org-1',
  venueId: 'venue-1',
  liveSystemId: 'live-1'
};

function socket() {
  return { send: vi.fn(), close: vi.fn() };
}

describe('RemoteRelayRegistry', () => {
  it('binds clients to the exact node scope and detaches on node loss', () => {
    const registry = new RemoteRelayRegistry();
    registry.registerNode({
      id: 'n-1',
      identity: { uid: 'owner' },
      scope,
      socket: socket(),
      connectedAt: 'now'
    });
    registry.registerClient({
      id: 'c-1',
      identity: { uid: 'tech' },
      scope,
      socket: socket(),
      connectedAt: 'now'
    });
    registry.authenticateClient({
      clientId: 'c-1',
      nodeId: 'n-1',
      grant: {
        id: 'g-1',
        organizationId: 'org-1',
        venueId: 'venue-1',
        liveSystemId: 'live-1',
        actorId: 'tech',
        role: 'operator',
        permissions: ['audio.read'],
        issuedAt: '2026-10-06T18:00:00Z',
        expiresAt: '2026-10-06T19:00:00Z'
      }
    });

    expect(registry.counts().authenticatedClients).toBe(1);
    expect(registry.removeNode('n-1')).toHaveLength(1);
    expect(registry.client('c-1')?.grant).toBeUndefined();
  });
});
