import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LiveDropAsset } from '@millionsnest/nestlive-production-domain';
import { stageAndOpenPeerLiveDrop } from '../src/liveDropFederation';
import type { PeerNodeRecord } from '../src/peerNodeStore';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const peer: PeerNodeRecord = {
  nodeId: 'node_led',
  baseUrl: 'http://192.168.1.44:4317',
  token: 'peer-token',
  displayName: 'PC LED',
  organizationId: 'org_1',
  venueId: 'venue_1',
  liveSystemId: 'system_1',
  pairedAt: '2026-09-20T00:00:00.000Z'
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-peer-'));
  const filePath = join(dir, 'video.mp4');
  const body = Buffer.from('approved-video-bytes');
  await writeFile(filePath, body);
  const sha256 = createHash('sha256').update(body).digest('hex');

  const asset: LiveDropAsset = {
    id: 'asset_local',
    organizationId: 'org_1',
    venueId: 'venue_1',
    liveSystemId: 'system_1',
    nodeId: 'node_control',
    fileName: 'video.mp4',
    mediaType: 'video',
    contentType: 'video/mp4',
    sizeBytes: body.length,
    sha256,
    status: 'ready',
    uploadedAt: '2026-09-20T00:00:00.000Z',
    uploadedBy: 'user_1',
    reviewedAt: '2026-09-20T00:01:00.000Z',
    reviewedBy: 'operator_1',
    expiresAt: null
  };

  return { filePath, asset };
}

describe('Live Drop federation', () => {
  it('streams an approved asset to the provider-hosting Node, verifies it and opens it there', async () => {
    const { filePath, asset } = await fixture();
    const calls: string[] = [];

    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      calls.push(`${String(init?.method || 'GET').toUpperCase()} ${url}`);

      if (url.endsWith('/live-drop') && !init?.method) {
        return json({ assets: [], maxBytes: 250 * 1024 * 1024 });
      }

      if (url.endsWith('/live-drop') && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        expect(headers.get('authorization')).toBe('Bearer peer-token');
        expect(headers.get('content-type')).toBe('video/mp4');
        expect(headers.get('x-live-file-name')).toBe('video.mp4');
        expect(headers.get('x-live-actor-id')).toBe('operator_1');
        return json({
          asset: {
            ...asset,
            id: 'asset_remote',
            nodeId: 'node_led',
            status: 'quarantined'
          }
        }, 201);
      }

      if (url.endsWith('/live-drop/asset_remote/review')) {
        return json({
          asset: {
            ...asset,
            id: 'asset_remote',
            nodeId: 'node_led',
            status: 'ready'
          }
        });
      }

      if (url.endsWith('/live-drop/asset_remote/open')) {
        expect(JSON.parse(String(init?.body || '{}'))).toMatchObject({
          actorId: 'operator_1',
          liveSessionId: 'music-scale:scale_1',
          providerId: 'resolume-primary',
          serviceItemId: 'live-media:item_1'
        });
        return json({
          asset: {
            ...asset,
            id: 'asset_remote',
            nodeId: 'node_led',
            status: 'ready'
          },
          correlationId: 'corr_remote',
          results: [{
            commandId: 'cmd_remote',
            providerInstanceId: 'resolume-primary',
            accepted: true,
            latencyMs: 12
          }]
        });
      }

      return json({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    const result = await stageAndOpenPeerLiveDrop({
      peer,
      localAsset: asset,
      localPath: filePath,
      remoteProviderId: 'resolume-primary',
      federatedProviderId: 'peer:node_led:resolume-primary',
      actorId: 'operator_1',
      liveSessionId: 'music-scale:scale_1',
      serviceItemId: 'live-media:item_1',
      fetchImpl
    });

    expect(result.reused).toBe(false);
    expect(result.targetNodeId).toBe('node_led');
    expect(result.results[0]?.providerInstanceId)
      .toBe('peer:node_led:resolume-primary');
    expect(calls).toEqual([
      'GET http://192.168.1.44:4317/live-drop',
      'POST http://192.168.1.44:4317/live-drop',
      'POST http://192.168.1.44:4317/live-drop/asset_remote/review',
      'POST http://192.168.1.44:4317/live-drop/asset_remote/open'
    ]);
  });

  it('reuses an identical ready peer copy instead of retransferring it', async () => {
    const { filePath, asset } = await fixture();
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);

      if (url.endsWith('/live-drop') && !init?.method) {
        return json({
          assets: [{
            ...asset,
            id: 'asset_remote_ready',
            nodeId: 'node_led',
            status: 'ready'
          }],
          maxBytes: 250 * 1024 * 1024
        });
      }

      if (url.endsWith('/live-drop/asset_remote_ready/open')) {
        return json({
          asset: {
            ...asset,
            id: 'asset_remote_ready',
            nodeId: 'node_led',
            status: 'ready'
          },
          correlationId: 'corr_reused',
          results: [{
            commandId: 'cmd_remote',
            providerInstanceId: 'resolume-primary',
            accepted: true,
            latencyMs: 5
          }]
        });
      }

      return json({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    const result = await stageAndOpenPeerLiveDrop({
      peer,
      localAsset: asset,
      localPath: filePath,
      remoteProviderId: 'resolume-primary',
      federatedProviderId: 'peer:node_led:resolume-primary',
      actorId: 'operator_1',
      liveSessionId: 'session_1',
      fetchImpl
    });

    expect(result.reused).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a peer outside the asset scope before any transfer', async () => {
    const { filePath, asset } = await fixture();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(stageAndOpenPeerLiveDrop({
      peer: { ...peer, venueId: 'other_venue' },
      localAsset: asset,
      localPath: filePath,
      remoteProviderId: 'resolume-primary',
      federatedProviderId: 'peer:node_led:resolume-primary',
      actorId: 'operator_1',
      liveSessionId: 'session_1',
      fetchImpl
    })).rejects.toThrow('peer_live_drop_scope_mismatch');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects and removes a transferred copy when the peer hash does not match', async () => {
    const { filePath, asset } = await fixture();
    let rejected = false;
    let opened = false;

    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.endsWith('/live-drop') && !init?.method) {
        return json({ assets: [], maxBytes: 250 * 1024 * 1024 });
      }
      if (url.endsWith('/live-drop') && init?.method === 'POST') {
        return json({
          asset: {
            ...asset,
            id: 'asset_corrupt',
            nodeId: 'node_led',
            sha256: '0'.repeat(64),
            status: 'quarantined'
          }
        }, 201);
      }
      if (url.endsWith('/live-drop/asset_corrupt/review')) {
        rejected = true;
        expect(JSON.parse(String(init?.body || '{}')).status).toBe('rejected');
        return json({
          asset: {
            ...asset,
            id: 'asset_corrupt',
            nodeId: 'node_led',
            status: 'rejected'
          }
        });
      }
      if (url.endsWith('/open')) opened = true;
      return json({ error: 'unexpected' }, 404);
    }) as typeof fetch;

    await expect(stageAndOpenPeerLiveDrop({
      peer,
      localAsset: asset,
      localPath: filePath,
      remoteProviderId: 'resolume-primary',
      federatedProviderId: 'peer:node_led:resolume-primary',
      actorId: 'operator_1',
      liveSessionId: 'session_1',
      fetchImpl
    })).rejects.toThrow('peer_live_drop_hash_mismatch');

    expect(rejected).toBe(true);
    expect(opened).toBe(false);
  });
});
