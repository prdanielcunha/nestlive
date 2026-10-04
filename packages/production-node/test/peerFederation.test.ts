import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityEngine } from '@millionsnest/nestlive-production-domain';
import { PeerFederation } from '../src/peerFederation';
import { PeerNodeStore } from '../src/peerNodeStore';

function makeFederation(fetchImpl: typeof fetch, storePath: string) {
  return new PeerFederation({
    localNodeId: 'node_local',
    localDisplayName: 'PC Controle',
    capabilityEngine: new CapabilityEngine(),
    store: new PeerNodeStore(storePath),
    fetchImpl
  });
}

const scope = {
  baseUrl: 'http://192.168.1.44:4317',
  organizationId: 'org_1',
  venueId: 'venue_1',
  liveSystemId: 'system_1'
};

describe('PeerFederation brand compatibility', () => {
  it('pairs with the canonical NestLive discovery endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nestlive-peer-'));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/nestlive-node')) {
        return new Response(JSON.stringify({
          product: 'NestLive Node',
          protocolVersion: 1,
          version: '0.1.0-alpha.1',
          nodeId: 'node_led',
          hostname: 'PC LED',
          port: 4317
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pairing/request')) {
        return new Response(JSON.stringify({
          challengeId: 'challenge_1',
          nodeId: 'node_led',
          expiresAt: '2099-01-01T00:00:00.000Z',
          method: 'pin',
          displayedOnNode: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const federation = makeFederation(fetchImpl, join(dir, 'peers.json'));
    const challenge = await federation.requestPairing(scope);

    expect(challenge.remoteNodeId).toBe('node_led');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.1.44:4317/.well-known/nestlive-node',
      expect.anything()
    );
  });

  it('keeps legacy alpha nodes pairable during rolling upgrades', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nestlive-peer-'));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/.well-known/nestlive-node')) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.endsWith('/.well-known/millionsnest-live-node')) {
        return new Response(JSON.stringify({
          product: 'MillionsNest Live Node',
          protocolVersion: 1,
          version: '0.1.0-alpha.1',
          nodeId: 'node_legacy',
          hostname: 'PC Holyrics',
          port: 4317
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/pairing/request')) {
        return new Response(JSON.stringify({
          challengeId: 'challenge_legacy',
          nodeId: 'node_legacy',
          expiresAt: '2099-01-01T00:00:00.000Z',
          method: 'pin',
          displayedOnNode: true
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const federation = makeFederation(fetchImpl, join(dir, 'peers.json'));
    const challenge = await federation.requestPairing(scope);

    expect(challenge.remoteNodeId).toBe('node_legacy');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://192.168.1.44:4317/.well-known/millionsnest-live-node',
      expect.anything()
    );
  });
});
