import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type {
  CommandResult,
  LiveDropAsset
} from '@millionsnest/nestlive-production-domain';
import type { PeerNodeRecord } from './peerNodeStore';

type FetchLike = typeof fetch;

interface RemoteLiveDropList {
  assets: LiveDropAsset[];
  maxBytes: number;
}

interface RemoteLiveDropUpload {
  asset: LiveDropAsset;
}

interface RemoteLiveDropOpen {
  asset: LiveDropAsset;
  correlationId: string;
  results: CommandResult[];
}

export interface PeerLiveDropResult {
  asset: LiveDropAsset;
  correlationId: string;
  results: CommandResult[];
  reused: boolean;
  targetNodeId: string;
}

function assertPeerScope(
  peer: PeerNodeRecord,
  asset: LiveDropAsset
): void {
  if (
    peer.organizationId !== asset.organizationId ||
    peer.venueId !== asset.venueId ||
    peer.liveSystemId !== asset.liveSystemId
  ) {
    throw new Error('peer_live_drop_scope_mismatch');
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code =
      body &&
      typeof body === 'object' &&
      'error' in body
        ? String((body as Record<string, unknown>).error || 'peer_live_drop_request_failed')
        : 'peer_live_drop_request_failed';
    throw new Error(code);
  }
  return body as T;
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  peer: Pick<PeerNodeRecord, 'baseUrl' | 'token'>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${peer.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${peer.token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {})
        }
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('peer_live_drop_timeout');
      }
      throw new Error('peer_live_drop_unreachable');
    }
    return responseJson<T>(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadToPeer(
  fetchImpl: FetchLike,
  peer: PeerNodeRecord,
  asset: LiveDropAsset,
  filePath: string,
  actorId: string
): Promise<LiveDropAsset> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size !== asset.sizeBytes) {
    throw new Error('peer_live_drop_source_changed');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
  const stream = createReadStream(filePath);

  try {
    const body = Readable.toWeb(stream) as unknown as BodyInit;
    const init = {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${peer.token}`,
        'Content-Type': asset.contentType || 'application/octet-stream',
        'Content-Length': String(asset.sizeBytes),
        'x-live-file-name': encodeURIComponent(asset.fileName),
        'x-live-actor-id': actorId
      },
      body,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' };

    let response: Response;
    try {
      response = await fetchImpl(`${peer.baseUrl}/live-drop`, init);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('peer_live_drop_transfer_timeout');
      }
      throw new Error('peer_live_drop_transfer_failed');
    }
    const uploaded = await responseJson<RemoteLiveDropUpload>(response);
    return uploaded.asset;
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
}

async function rejectPeerCopy(
  fetchImpl: FetchLike,
  peer: PeerNodeRecord,
  assetId: string,
  reviewedBy: string
): Promise<void> {
  await requestJson(
    fetchImpl,
    peer,
    `/live-drop/${encodeURIComponent(assetId)}/review`,
    {
      method: 'POST',
      body: JSON.stringify({
        status: 'rejected',
        reviewedBy
      })
    },
    5000
  ).catch(() => undefined);
}

export async function stageAndOpenPeerLiveDrop(options: {
  peer: PeerNodeRecord;
  localAsset: LiveDropAsset;
  localPath: string;
  remoteProviderId: string;
  federatedProviderId: string;
  actorId: string;
  liveSessionId: string;
  serviceItemId?: string;
  fetchImpl?: FetchLike;
}): Promise<PeerLiveDropResult> {
  const {
    peer,
    localAsset,
    localPath,
    remoteProviderId,
    federatedProviderId,
    actorId,
    liveSessionId,
    serviceItemId
  } = options;
  const fetchImpl = options.fetchImpl || fetch;

  if (localAsset.status !== 'ready') {
    throw new Error('live_drop_asset_not_ready');
  }
  if (!remoteProviderId.trim()) {
    throw new Error('peer_live_drop_provider_required');
  }
  if (!actorId.trim() || !liveSessionId.trim()) {
    throw new Error('peer_live_drop_context_required');
  }

  assertPeerScope(peer, localAsset);

  const remote = await requestJson<RemoteLiveDropList>(
    fetchImpl,
    peer,
    '/live-drop',
    {},
    7000
  );

  if (
    Number.isFinite(remote.maxBytes) &&
    remote.maxBytes > 0 &&
    localAsset.sizeBytes > remote.maxBytes
  ) {
    throw new Error('peer_live_drop_too_large');
  }

  let remoteAsset = (remote.assets || []).find(candidate =>
    candidate.status === 'ready' &&
    candidate.sha256 === localAsset.sha256 &&
    candidate.sizeBytes === localAsset.sizeBytes &&
    candidate.contentType === localAsset.contentType
  ) || null;
  let reused = Boolean(remoteAsset);

  if (!remoteAsset) {
    const uploaded = await uploadToPeer(
      fetchImpl,
      peer,
      localAsset,
      localPath,
      actorId
    );

    if (
      uploaded.sha256 !== localAsset.sha256 ||
      uploaded.sizeBytes !== localAsset.sizeBytes
    ) {
      await rejectPeerCopy(fetchImpl, peer, uploaded.id, actorId);
      throw new Error('peer_live_drop_hash_mismatch');
    }

    const review = await requestJson<{ asset: LiveDropAsset }>(
      fetchImpl,
      peer,
      `/live-drop/${encodeURIComponent(uploaded.id)}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          status: 'ready',
          reviewedBy: actorId
        })
      },
      7000
    );
    remoteAsset = review.asset;
    reused = false;
  }

  if (remoteAsset.status !== 'ready') {
    throw new Error('peer_live_drop_remote_not_ready');
  }

  const opened = await requestJson<RemoteLiveDropOpen>(
    fetchImpl,
    peer,
    `/live-drop/${encodeURIComponent(remoteAsset.id)}/open`,
    {
      method: 'POST',
      body: JSON.stringify({
        actorId,
        liveSessionId,
        providerId: remoteProviderId,
        serviceItemId
      })
    },
    20_000
  );

  return {
    asset: opened.asset,
    correlationId: opened.correlationId,
    results: opened.results.map(result => ({
      ...result,
      providerInstanceId:
        result.providerInstanceId === remoteProviderId
          ? federatedProviderId
          : result.providerInstanceId
    })),
    reused,
    targetNodeId: peer.nodeId
  };
}
