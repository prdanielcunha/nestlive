import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Capability,
  CommandOrigin,
  LiveChatAudience,
  LiveChatMessage,
  LiveChatSenderContext,
  LiveCollaborationInvite,
  LiveCollaborationRole,
  CommandResult,
  LiveDropAsset,
  LiveNodeConnectionState,
  LiveNodeHealth,
  LiveCommand,
  LiveRequest,
  LiveSessionEventPage,
  PairingChallenge,
  PairingRequest,
  PairingScope,
  ProviderLink,
  ProviderRouteGroup,
  SafetyLevel,
  Scene,
  SceneExecutionResult,
  ServicePlan,
  SignalTopology
} from '@millionsnest/nestlive-production-domain';
import {
  clearLiveNodeCredential,
  loadLiveNodeCredential,
  saveLiveNodeCredential,
  type StoredLiveNodeCredential
} from './credentialStore';
import { defaultDeviceName, getOrCreateDeviceId } from './deviceIdentity';
import {
  cacheNodeServicePlan,
  cacheNodeScenes,
  completePairing,
  completePeerNodePairing,
  createNodeCollaborationInvite,
  discoverPeerNodes,
  executeNodeCommand,
  executeNodeScene,
  fetchProviderClipThumbnail,
  fetchProviderOutputSnapshot,
  heartbeatNode,
  listNodeChatMessages,
  listNodeCollaborationInvites,
  listNodeEvents,
  listNodeLiveDrop,
  loadNodeState,
  openNodeLiveDrop,
  probeNode,
  redeemNodeCollaborationInvite,
  requestPairing,
  requestPeerNodePairing,
  removePeerNode,
  revokeNodeCollaborationSession,
  revokeNodePairing,
  reviewNodeLiveDrop,
  saveNodeSignalTopology,
  setNodeLiveDropRetentionPreset,
  setNodeProviderRoute,
  submitNodeChatMessage,
  submitNodeLiveRequest,
  uploadNodeLiveDrop,
  updateNodeLiveRequestStatus,
  type DiscoveredLiveNode,
  type LiveDropRetentionPolicy,
  type LiveDropRetentionPreset,
  type LiveNodeApiError,
  type LiveNodeStateResponse,
  type PeerNodePairingChallenge
} from './liveNodeClient';
import { transportBroker } from './transportBroker';
import { createClientId } from './clientId';
import { liveFeatureFlags } from './featureFlags';
import {
  createCloudLiveRequest,
  resolveCloudLiveRequest
} from './liveCloudRepository';

interface PendingPairing {
  baseUrl: string;
  transportKind: 'direct-lan' | 'local-console' | 'cloud-relay';
  challenge: PairingChallenge;
  deviceId: string;
  deviceName: string;
}

export function useLiveNode() {
  const [state, setState] = useState<LiveNodeConnectionState>('unconfigured');
  const [health, setHealth] = useState<LiveNodeHealth | null>(null);
  const [credential, setCredential] = useState<StoredLiveNodeCredential | null>(null);
  const [nodeState, setNodeState] = useState<LiveNodeStateResponse | null>(null);
  const [pending, setPending] = useState<PendingPairing | null>(null);
  const [pendingPeer, setPendingPeer] = useState<PeerNodePairingChallenge | null>(null);
  const [nearbyNodes, setNearbyNodes] = useState<DiscoveredLiveNode[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState<'idle' | 'starting' | 'online' | 'unavailable'>('idle');
  const [peerErrorCode, setPeerErrorCode] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const failures = useRef(0);

  const markError = useCallback((error: unknown, fallback: LiveNodeConnectionState) => {
    failures.current += 1;
    setState(failures.current >= 2 ? 'reconnecting' : fallback);
    setErrorCode((error as LiveNodeApiError)?.code || (error instanceof Error ? error.message : 'node_unreachable'));
  }, []);

  const heartbeat = useCallback(async (value: StoredLiveNodeCredential) => {
    try {
      await heartbeatNode(value.baseUrl, value.token);
      const [nextHealth, nextState] = await Promise.all([
        probeNode(value.baseUrl),
        loadNodeState(value.baseUrl, value.token)
      ]);
      failures.current = 0;
      setHealth(nextHealth);
      setNodeState(nextState);
      setState('connected');
      setErrorCode(null);
      return true;
    } catch (error) {
      markError(error, 'degraded');
      return false;
    }
  }, [markError]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    (async () => {
      const stored = await loadLiveNodeCredential().catch(() => null);
      if (cancelled || !stored) return;

      setCredential(stored);
      setState('probing');
      await heartbeat(stored);

      const tick = async () => {
        if (cancelled) return;
        await heartbeat(stored);
        const delay = failures.current > 0
          ? Math.min(30_000, 2_000 * Math.pow(2, Math.min(4, failures.current)))
          : 5_000;
        timer = window.setTimeout(tick, delay);
      };
      timer = window.setTimeout(tick, 5_000);
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [heartbeat]);

  const beginPairing = useCallback(async (
    baseUrlInput: string,
    scope?: PairingScope,
    requestedDeviceName?: string
  ) => {
    setState('probing');
    setErrorCode(null);
    try {
      const transport = transportBroker.resolve(baseUrlInput);
      const baseUrl = transport.baseUrl;

      const nextHealth = await probeNode(baseUrl);
      setHealth(nextHealth);
      const deviceId = getOrCreateDeviceId();
      const deviceName = requestedDeviceName?.trim() || defaultDeviceName();

      setState('pairing');
      const pairingRequest: PairingRequest = {
        deviceId,
        deviceName,
        ...(scope || {})
      };
      const challenge = await requestPairing(baseUrl, pairingRequest);
      const value = { baseUrl, challenge, deviceId, deviceName, transportKind: transport.kind };
      setPending(value);
      return value;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'mixed_content_blocked') {
        setState('blocked');
        setErrorCode(code);
        return null;
      }
      markError(error, 'offline');
      return null;
    }
  }, [markError]);

  const finishPairing = useCallback(async (pin: string) => {
    if (!pending) return false;
    setErrorCode(null);
    try {
      const completed = await completePairing(pending.baseUrl, {
        challengeId: pending.challenge.challengeId,
        pin: pin.replace(/\D/g, '').slice(0, 6),
        deviceId: pending.deviceId,
        deviceName: pending.deviceName
      });
      const nextCredential: StoredLiveNodeCredential = {
        baseUrl: pending.baseUrl,
        transportKind: pending.transportKind,
        token: completed.token,
        binding: completed.binding
      };
      await saveLiveNodeCredential(nextCredential);
      setCredential(nextCredential);
      setPending(null);
      failures.current = 0;
      await heartbeat(nextCredential);
      return true;
    } catch (error) {
      setState('pairing');
      setErrorCode((error as LiveNodeApiError)?.code || 'pairing_failed');
      return false;
    }
  }, [heartbeat, pending]);

  const joinCollaborationInvite = useCallback(async (input: {
    baseUrl: string;
    inviteId: string;
    secret: string;
  }) => {
    setState('probing');
    setErrorCode(null);
    try {
      const transport = transportBroker.resolve(input.baseUrl);
      const baseUrl = transport.baseUrl;
      const deviceId = getOrCreateDeviceId();
      const deviceName = defaultDeviceName();
      const actorId = `collab-device:${deviceId}`;
      const redeemed = await redeemNodeCollaborationInvite(baseUrl, {
        inviteId: input.inviteId,
        secret: input.secret,
        actorId,
        deviceId,
        deviceName
      });
      const nextCredential: StoredLiveNodeCredential = {
        baseUrl,
        transportKind: transport.kind,
        token: redeemed.token,
        binding: redeemed.binding,
        collaboration: redeemed.collaboration
      };
      await saveLiveNodeCredential(nextCredential);
      setCredential(nextCredential);
      setPending(null);
      failures.current = 0;
      const connected = await heartbeat(nextCredential);
      if (!connected) throw new Error('collaboration_connect_failed');
      return nextCredential;
    } catch (error) {
      markError(error, 'offline');
      return null;
    }
  }, [heartbeat, markError]);

  const createCollaborationInvite = useCallback(async (input: {
    liveSessionId: string;
    role: LiveCollaborationRole;
    createdBy: string;
    ttlMinutes?: number;
    maxUses?: number;
  }) => {
    if (!credential || credential.collaboration) {
      throw new Error('collaboration_invite_admin_required');
    }
    return createNodeCollaborationInvite(
      credential.baseUrl,
      credential.token,
      input
    );
  }, [credential]);

  const listCollaborationInvites = useCallback(async (
    liveSessionId: string
  ): Promise<LiveCollaborationInvite[]> => {
    if (!credential || credential.collaboration) {
      throw new Error('collaboration_invite_admin_required');
    }
    return listNodeCollaborationInvites(
      credential.baseUrl,
      credential.token,
      liveSessionId
    );
  }, [credential]);

  const revokeCollaborationSession = useCallback(async (
    liveSessionId: string
  ): Promise<number> => {
    if (!credential || credential.collaboration) {
      throw new Error('collaboration_invite_admin_required');
    }
    return revokeNodeCollaborationSession(
      credential.baseUrl,
      credential.token,
      liveSessionId
    );
  }, [credential]);

  const refreshState = useCallback(async () => {
    if (!credential) throw new Error('node_not_paired');
    const refreshed = await loadNodeState(credential.baseUrl, credential.token);
    setNodeState(refreshed);
    return refreshed;
  }, [credential]);

  const refreshNearbyNodes = useCallback(async () => {
    if (!credential) {
      setNearbyNodes([]);
      setDiscoveryStatus('idle');
      return [];
    }

    try {
      const response = await discoverPeerNodes(credential.baseUrl, credential.token);
      setDiscoveryStatus(response.status);
      setNearbyNodes(response.peers);
      return response.peers;
    } catch {
      setDiscoveryStatus('unavailable');
      setNearbyNodes([]);
      return [];
    }
  }, [credential]);

  const beginPeerPairing = useCallback(async (peerBaseUrl: string) => {
    if (!credential) throw new Error('node_not_paired');
    setPeerErrorCode(null);
    try {
      const challenge = await requestPeerNodePairing(
        credential.baseUrl,
        credential.token,
        peerBaseUrl
      );
      setPendingPeer(challenge);
      return challenge;
    } catch (error) {
      setPeerErrorCode(
        (error as LiveNodeApiError)?.code ||
        (error instanceof Error ? error.message : 'peer_pairing_failed')
      );
      return null;
    }
  }, [credential]);

  const finishPeerPairing = useCallback(async (pin: string) => {
    if (!credential || !pendingPeer) return false;
    setPeerErrorCode(null);
    try {
      await completePeerNodePairing(
        credential.baseUrl,
        credential.token,
        pendingPeer.remoteNodeId,
        pin
      );
      setPendingPeer(null);
      await refreshState();
      return true;
    } catch (error) {
      setPeerErrorCode(
        (error as LiveNodeApiError)?.code ||
        (error instanceof Error ? error.message : 'peer_pairing_failed')
      );
      return false;
    }
  }, [credential, pendingPeer, refreshState]);

  const forgetPeerNode = useCallback(async (remoteNodeId: string) => {
    if (!credential) throw new Error('node_not_paired');
    setPeerErrorCode(null);
    try {
      await removePeerNode(
        credential.baseUrl,
        credential.token,
        remoteNodeId
      );
      await refreshState();
      return true;
    } catch (error) {
      setPeerErrorCode(
        (error as LiveNodeApiError)?.code ||
        (error instanceof Error ? error.message : 'peer_remove_failed')
      );
      return false;
    }
  }, [credential, refreshState]);

  const setProviderRoute = useCallback(async (
    group: ProviderRouteGroup,
    providerId: string | null
  ) => {
    if (!credential) throw new Error('node_not_paired');
    const response = await setNodeProviderRoute(
      credential.baseUrl,
      credential.token,
      group,
      providerId
    );
    const refreshed = await refreshState();
    return { ...response, state: refreshed };
  }, [credential, refreshState]);

  const saveSignalTopology = useCallback(async (
    topology: Pick<SignalTopology, 'endpoints' | 'links'>
  ) => {
    if (!credential) throw new Error('node_not_paired');
    const response = await saveNodeSignalTopology(
      credential.baseUrl,
      credential.token,
      topology
    );
    await refreshState();
    return response.topology;
  }, [credential, refreshState]);

  const listEvents = useCallback(async (
    liveSessionId?: string,
    limit = 80
  ): Promise<LiveSessionEventPage> => {
    if (!credential) throw new Error('node_not_paired');
    return listNodeEvents(
      credential.baseUrl,
      credential.token,
      liveSessionId,
      limit
    );
  }, [credential]);

  const listChatMessages = useCallback(async (
    liveSessionId: string,
    limit = 100
  ): Promise<LiveChatMessage[]> => {
    if (!credential) throw new Error('node_not_paired');
    const response = await listNodeChatMessages(
      credential.baseUrl,
      credential.token,
      liveSessionId,
      limit
    );
    return response.messages;
  }, [credential]);

  const sendChatMessage = useCallback(async (input: {
    id?: string;
    liveSessionId: string;
    actorId: string;
    senderContext: LiveChatSenderContext;
    audience: LiveChatAudience;
    text: string;
    replyToId?: string;
    relatedRequestId?: string;
    relatedServiceItemId?: string;
  }): Promise<LiveChatMessage> => {
    if (!credential) throw new Error('node_not_paired');
    const message: LiveChatMessage = {
      id: input.id || createClientId(),
      organizationId: credential.binding.organizationId,
      venueId: credential.binding.venueId,
      liveSystemId: credential.binding.liveSystemId,
      liveSessionId: input.liveSessionId,
      actorId: input.actorId,
      senderContext: input.senderContext,
      audience: input.audience,
      text: input.text.trim(),
      createdAt: new Date().toISOString(),
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.relatedRequestId ? { relatedRequestId: input.relatedRequestId } : {}),
      ...(input.relatedServiceItemId ? { relatedServiceItemId: input.relatedServiceItemId } : {})
    };

    const response = await submitNodeChatMessage(
      credential.baseUrl,
      credential.token,
      message
    );
    return response.message;
  }, [credential]);

  const submitRequest = useCallback(async (input: {
    id?: string;
    liveSessionId: string;
    actorId: string;
    kind: LiveRequest['kind'];
    payload: Record<string, unknown>;
    priority?: LiveRequest['priority'];
  }) => {
    if (!credential) throw new Error('node_not_paired');

    const request: LiveRequest = {
      id: input.id || createClientId(),
      organizationId: credential.binding.organizationId,
      venueId: credential.binding.venueId,
      liveSessionId: input.liveSessionId,
      actorId: input.actorId,
      kind: input.kind,
      payload: input.payload,
      status: 'sent',
      priority: input.priority || 'normal',
      createdAt: new Date().toISOString()
    };

    await submitNodeLiveRequest(credential.baseUrl, credential.token, request);
    await refreshState();

    if (liveFeatureFlags.servicePlanWrites && !credential.collaboration) {
      await createCloudLiveRequest(request).catch(() => undefined);
    }

    return request;
  }, [credential, refreshState]);

  const updateRequestStatus = useCallback(async (
    requestId: string,
    status: LiveRequest['status'],
    resolvedBy: string
  ) => {
    if (!credential) throw new Error('node_not_paired');
    const response = await updateNodeLiveRequestStatus(
      credential.baseUrl,
      credential.token,
      requestId,
      status,
      resolvedBy
    );
    await refreshState();

    if (liveFeatureFlags.servicePlanWrites && !credential.collaboration) {
      await resolveCloudLiveRequest({
        request: response.request,
        status,
        actorId: resolvedBy
      }).catch(() => undefined);
    }

    return response.request;
  }, [credential, refreshState]);

  const executeCommand = useCallback(async (input: {
    capability: Capability;
    payload?: Record<string, unknown>;
    liveSessionId: string;
    serviceItemId?: string;
    actorId: string;
    origin?: CommandOrigin;
    outputTargets?: string[];
    targetProviderIds?: string[];
    safetyLevel?: SafetyLevel;
    confirmed?: boolean;
  }): Promise<CommandResult[]> => {
    if (!credential) throw new Error('node_not_paired');

    const id = createClientId();
    const command: LiveCommand = {
      id,
      correlationId: createClientId(),
      organizationId: credential.binding.organizationId,
      venueId: credential.binding.venueId,
      liveSystemId: credential.binding.liveSystemId,
      liveSessionId: input.liveSessionId,
      serviceItemId: input.serviceItemId,
      actorId: input.actorId,
      origin: input.origin || 'live-ui',
      capability: input.capability,
      targetProviderIds: input.targetProviderIds || [],
      outputTargets: input.outputTargets || ['main'],
      payload: input.payload || {},
      idempotencyKey: createClientId(),
      createdAt: new Date().toISOString(),
      safetyLevel: input.safetyLevel || 'normal'
    };

    const response = await executeNodeCommand(
      credential.baseUrl,
      credential.token,
      command,
      input.confirmed === true
    );
    const refreshed = await loadNodeState(
      credential.baseUrl,
      credential.token
    ).catch(() => null);
    if (refreshed) setNodeState(refreshed);
    return response.results;
  }, [credential]);

  const executeScene = useCallback(async (input: {
    scene: Scene;
    liveSessionId: string;
    serviceItemId?: string;
    actorId: string;
    origin?: CommandOrigin;
    confirmed?: boolean;
  }): Promise<SceneExecutionResult> => {
    if (!credential) throw new Error('node_not_paired');

    const requestId = createClientId();
    const result = await executeNodeScene(
      credential.baseUrl,
      credential.token,
      {
        id: requestId,
        correlationId: createClientId(),
        organizationId: credential.binding.organizationId,
        venueId: credential.binding.venueId,
        liveSystemId: credential.binding.liveSystemId,
        liveSessionId: input.liveSessionId,
        serviceItemId: input.serviceItemId,
        actorId: input.actorId,
        origin: input.origin || 'live-ui',
        scene: input.scene,
        idempotencyKey: createClientId()
      },
      input.confirmed === true
    );

    const refreshed = await loadNodeState(
      credential.baseUrl,
      credential.token
    ).catch(() => null);
    if (refreshed) setNodeState(refreshed);
    return result;
  }, [credential]);

  const listLiveDrop = useCallback(async (): Promise<{
    assets: LiveDropAsset[];
    maxBytes: number;
    retention?: LiveDropRetentionPolicy;
  }> => {
    if (!credential) throw new Error('node_not_paired');
    return listNodeLiveDrop(credential.baseUrl, credential.token);
  }, [credential]);

  const setLiveDropRetentionPreset = useCallback(async (
    preset: LiveDropRetentionPreset
  ): Promise<LiveDropRetentionPolicy> => {
    if (!credential) throw new Error('node_not_paired');
    const response = await setNodeLiveDropRetentionPreset(
      credential.baseUrl,
      credential.token,
      preset
    );
    await refreshState();
    return response.retention;
  }, [credential, refreshState]);

  const uploadLiveDrop = useCallback(async (
    file: File,
    actorId: string
  ): Promise<LiveDropAsset> => {
    if (!credential) throw new Error('node_not_paired');
    const asset = await uploadNodeLiveDrop(
      credential.baseUrl,
      credential.token,
      file,
      actorId
    );
    await refreshState();
    return asset;
  }, [credential, refreshState]);

  const reviewLiveDrop = useCallback(async (
    assetId: string,
    status: 'ready' | 'rejected',
    reviewedBy: string
  ): Promise<LiveDropAsset> => {
    if (!credential) throw new Error('node_not_paired');
    const asset = await reviewNodeLiveDrop(
      credential.baseUrl,
      credential.token,
      assetId,
      status,
      reviewedBy
    );
    await refreshState();
    return asset;
  }, [credential, refreshState]);

  const openLiveDrop = useCallback(async (
    assetId: string,
    input: {
      actorId: string;
      liveSessionId: string;
      providerId?: string;
      serviceItemId?: string;
    }
  ) => {
    if (!credential) throw new Error('node_not_paired');
    const response = await openNodeLiveDrop(
      credential.baseUrl,
      credential.token,
      assetId,
      input
    );
    await refreshState();
    return response;
  }, [credential, refreshState]);

  const fetchOutputSnapshot = useCallback(async (
    providerId: string,
    targetId: string,
    format: 'jpeg' | 'png' = 'jpeg'
  ): Promise<Blob> => {
    if (!credential) throw new Error('node_not_paired');
    return fetchProviderOutputSnapshot(
      credential.baseUrl,
      credential.token,
      providerId,
      targetId,
      format
    );
  }, [credential]);

  const fetchClipThumbnail = useCallback(async (
    providerId: string,
    clipId: string
  ): Promise<Blob> => {
    if (!credential) throw new Error('node_not_paired');
    return fetchProviderClipThumbnail(
      credential.baseUrl,
      credential.token,
      providerId,
      clipId
    );
  }, [credential]);

  const cacheServicePlan = useCallback(async (
    plan: ServicePlan,
    providerLinks: ProviderLink[] = []
  ) => {
    if (!credential) throw new Error('node_not_paired');
    await cacheNodeServicePlan(
      credential.baseUrl,
      credential.token,
      plan,
      providerLinks
    );
    const refreshed = await loadNodeState(
      credential.baseUrl,
      credential.token
    );
    setNodeState(refreshed);
    return refreshed;
  }, [credential]);

  const cacheScenes = useCallback(async (scenes: Scene[]) => {
    if (!credential) throw new Error('node_not_paired');
    await cacheNodeScenes(credential.baseUrl, credential.token, scenes);
    const refreshed = await loadNodeState(credential.baseUrl, credential.token);
    setNodeState(refreshed);
    return refreshed;
  }, [credential]);

  const testConnection = useCallback(async (): Promise<{
    ok: boolean;
    latencyMs: number;
    providersOnline: number;
    stateRevision: number;
  }> => {
    if (!credential) throw new Error('node_not_paired');
    const started = performance.now();
    const [heartbeatResult, nextHealth, nextState] = await Promise.all([
      heartbeatNode(credential.baseUrl, credential.token),
      probeNode(credential.baseUrl),
      loadNodeState(credential.baseUrl, credential.token)
    ]);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    failures.current = 0;
    setHealth(nextHealth);
    setNodeState(nextState);
    setState('connected');
    setErrorCode(null);
    return {
      ok: true,
      latencyMs,
      providersOnline: nextHealth.providersOnline,
      stateRevision: heartbeatResult.stateRevision
    };
  }, [credential]);

  const disconnect = useCallback(async () => {
    const current = credential;
    if (current) {
      await revokeNodePairing(
        current.baseUrl,
        current.token,
        current.binding.deviceId
      ).catch(() => {});
    }
    await clearLiveNodeCredential();
    setCredential(null);
    setPending(null);
    setPendingPeer(null);
    setNearbyNodes([]);
    setDiscoveryStatus('idle');
    setPeerErrorCode(null);
    setHealth(null);
    setNodeState(null);
    setState('unconfigured');
    setErrorCode(null);
    failures.current = 0;
  }, [credential]);

  return {
    state,
    health,
    credential,
    nodeState,
    pending,
    pendingPeer,
    nearbyNodes,
    discoveryStatus,
    peerErrorCode,
    errorCode,
    beginPairing,
    finishPairing,
    joinCollaborationInvite,
    createCollaborationInvite,
    listCollaborationInvites,
    revokeCollaborationSession,
    refreshNearbyNodes,
    beginPeerPairing,
    finishPeerPairing,
    forgetPeerNode,
    setProviderRoute,
    saveSignalTopology,
    listEvents,
    listChatMessages,
    sendChatMessage,
    executeCommand,
    executeScene,
    listLiveDrop,
    setLiveDropRetentionPreset,
    uploadLiveDrop,
    reviewLiveDrop,
    openLiveDrop,
    fetchOutputSnapshot,
    fetchClipThumbnail,
    cacheServicePlan,
    refreshState,
    submitRequest,
    updateRequestStatus,
    cacheScenes,
    testConnection,
    disconnect
  };
}
