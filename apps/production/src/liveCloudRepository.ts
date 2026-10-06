import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  setDoc,
  where,
  type Unsubscribe
} from 'firebase/firestore';
import type {
  AudioProfile,
  AutomationRule,
  LiveEvent,
  LivePresence,
  LiveRequest,
  LiveSession,
  LiveTemplate,
  ProviderLink,
  Scene,
  ServicePlan,
  SyncEntityKind,
  SyncMutation
} from '@millionsnest/nestlive-production-domain';
import { transitionLiveRequest } from '@millionsnest/nestlive-production-domain';
import { db } from './firebase';
import { LIVE_COLLECTIONS } from './liveCollections';
import {
  initializeLiveSync,
  liveSyncEngine,
  queueLiveSync
} from './liveSync';

interface RemoteSyncMeta {
  version?: string;
  mutationId?: string;
}

export interface LiveChangeHistoryRecord {
  id: string;
  organizationId: string;
  venueId?: string;
  liveSystemId?: string;
  entityKind: SyncEntityKind;
  entityId: string;
  operation: SyncMutation['operation'];
  payload: Record<string, unknown> | null;
  baseVersion?: string | null;
  version: string;
  origin: SyncMutation['origin'];
  actorId: string;
  createdAt: string;
  committedAt: string;
}

function stableDocId(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .join('__')
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 900);
}

function readRemoteSync(data: Record<string, unknown>): RemoteSyncMeta {
  return data._sync && typeof data._sync === 'object'
    ? data._sync as RemoteSyncMeta
    : {};
}

function stripRemoteSync<T>(data: Record<string, unknown>): T {
  const { _sync: _ignoredSync, ...payload } = data;
  return payload as T;
}

function observeRemote(
  entityKind: SyncEntityKind,
  entityId: string,
  data: Record<string, unknown>
): void {
  const sync = readRemoteSync(data);
  void liveSyncEngine.observeRemote({
    entityKind,
    entityId,
    version: sync.version || null,
    mutationId: sync.mutationId || null,
    payload: stripRemoteSync<Record<string, unknown>>(data)
  });
}

export async function syncPreparedServicePlan(
  plan: ServicePlan,
  providerLinks: ProviderLink[],
  actorId: string
): Promise<void> {
  await initializeLiveSync();

  await queueLiveSync({
    organizationId: plan.organizationId,
    venueId: plan.venueId,
    liveSystemId: plan.liveSystemId,
    entityKind: 'servicePlan',
    entityId: plan.id,
    payload: {
      ...plan,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId
    },
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });

  await Promise.all(providerLinks.map(async link => {
    const id = link.id || stableDocId([
      link.organizationId,
      link.venueId,
      link.providerInstanceId,
      link.musicScaleEntityId,
      link.externalId
    ]);

    await queueLiveSync({
      organizationId: link.organizationId,
      venueId: link.venueId,
      entityKind: 'providerLink',
      entityId: id,
      payload: {
        ...link,
        id,
        updatedAt: new Date().toISOString(),
        updatedBy: actorId
      },
      origin: 'studio',
      actorId,
      conflictPolicy: 'last-write-wins'
    });
  }));

  await liveSyncEngine.flush();
}

export interface CloudFleetNode {
  id: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  nodeId: string;
  displayName: string;
  health: string;
  providers: number;
  providersOnline: number;
  version?: string;
  lastSeenAt: string;
  updatedBy: string;
}

export async function upsertCloudFleetPresence(input: Omit<CloudFleetNode, 'id'>): Promise<void> {
  const id = stableDocId([input.organizationId, input.nodeId]);
  await setDoc(doc(db, LIVE_COLLECTIONS.fleetPresence, id), {
    id,
    ...input
  }, { merge: true });
}

export function subscribeCloudFleet(
  organizationId: string,
  onChange: (nodes: CloudFleetNode[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, LIVE_COLLECTIONS.fleetPresence),
    where('organizationId', '==', organizationId)
  );
  return onSnapshot(q, snapshot => {
    const nodes = snapshot.docs
      .map(item => item.data() as CloudFleetNode)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    onChange(nodes);
  }, error => onError?.(error));
}

export async function saveCloudAudioProfile(
  profile: AudioProfile,
  actorId: string
): Promise<void> {
  await queueLiveSync({
    organizationId: profile.organizationId,
    venueId: profile.venueId,
    liveSystemId: profile.liveSystemId,
    entityKind: 'audioProfile',
    entityId: profile.id,
    payload: {
      ...profile,
      updatedAt: new Date().toISOString()
    },
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export async function listCloudAudioProfiles(
  organizationId: string,
  venueId?: string,
  liveSystemId?: string
): Promise<AudioProfile[]> {
  const snapshot = await getDocs(query(
    collection(db, LIVE_COLLECTIONS.audioProfiles),
    where('organizationId', '==', organizationId)
  ));
  return snapshot.docs
    .map(item => {
      const data = item.data() as Record<string, unknown>;
      observeRemote('audioProfile', item.id, data);
      return stripRemoteSync<AudioProfile>(data);
    })
    .filter(profile => !venueId || profile.venueId === venueId)
    .filter(profile => !liveSystemId || profile.liveSystemId === liveSystemId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveCloudLiveTemplate(
  template: LiveTemplate,
  actorId: string
): Promise<void> {
  if (!['private', 'review'].includes(template.marketplaceStatus)) {
    throw new Error('marketplace_decision_requires_controlled_review');
  }
  await queueLiveSync({
    organizationId: template.organizationId,
    entityKind: 'template',
    entityId: template.id,
    payload: {
      ...template,
      shared: false,
      updatedAt: new Date().toISOString()
    },
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export async function listCloudLiveTemplates(
  organizationId: string
): Promise<LiveTemplate[]> {
  const snapshot = await getDocs(query(
    collection(db, LIVE_COLLECTIONS.templates),
    where('organizationId', '==', organizationId)
  ));
  return snapshot.docs
    .map(item => {
      const data = item.data() as Record<string, unknown>;
      observeRemote('template', item.id, data);
      return stripRemoteSync<LiveTemplate>(data);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertLiveSession(
  session: LiveSession,
  actorId: string
): Promise<void> {
  await setDoc(doc(db, LIVE_COLLECTIONS.sessions, session.id), {
    ...session,
    startedBy: actorId,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId
  }, { merge: true });
}

export async function appendLiveEvent(event: LiveEvent): Promise<void> {
  await setDoc(doc(db, LIVE_COLLECTIONS.events, event.id), event);
}

export async function listScenes(
  organizationId: string,
  venueId?: string,
  liveSystemId?: string
): Promise<Scene[]> {
  const snapshot = await getDocs(query(
    collection(db, LIVE_COLLECTIONS.scenes),
    where('organizationId', '==', organizationId)
  ));

  return snapshot.docs
    .map(item => {
      const data = item.data() as Record<string, unknown>;
      observeRemote('scene', item.id, data);
      return stripRemoteSync<Scene>(data);
    })
    .filter(scene => !venueId || scene.venueId === venueId)
    .filter(scene => !liveSystemId || !scene.liveSystemId || scene.liveSystemId === liveSystemId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function subscribeCloudScenes(
  organizationId: string,
  onChange: (scenes: Scene[]) => void,
  options?: {
    venueId?: string;
    liveSystemId?: string;
    onError?: (error: Error) => void;
  }
): Unsubscribe {
  const q = query(
    collection(db, LIVE_COLLECTIONS.scenes),
    where('organizationId', '==', organizationId)
  );

  return onSnapshot(q, snapshot => {
    const scenes = snapshot.docs
      .map(item => {
        const data = item.data() as Record<string, unknown>;
        observeRemote('scene', item.id, data);
        return stripRemoteSync<Scene>(data);
      })
      .filter(scene => !options?.venueId || scene.venueId === options.venueId)
      .filter(scene =>
        !options?.liveSystemId ||
        !scene.liveSystemId ||
        scene.liveSystemId === options.liveSystemId
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    onChange(scenes);
  }, error => options?.onError?.(error));
}

export async function saveScene(scene: Scene, actorId: string): Promise<void> {
  await queueLiveSync({
    organizationId: scene.organizationId,
    venueId: scene.venueId,
    liveSystemId: scene.liveSystemId,
    entityKind: 'scene',
    entityId: scene.id,
    payload: {
      ...scene,
      updatedAt: new Date().toISOString(),
      updatedBy: actorId
    },
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export async function removeScene(scene: Scene, actorId: string): Promise<void> {
  await queueLiveSync({
    organizationId: scene.organizationId,
    venueId: scene.venueId,
    liveSystemId: scene.liveSystemId,
    entityKind: 'scene',
    entityId: scene.id,
    operation: 'delete',
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export async function listAutomations(
  organizationId: string,
  venueId?: string
): Promise<AutomationRule[]> {
  const snapshot = await getDocs(query(
    collection(db, LIVE_COLLECTIONS.automations),
    where('organizationId', '==', organizationId)
  ));

  return snapshot.docs
    .map(item => item.data() as AutomationRule)
    .filter(rule => !venueId || rule.venueId === venueId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveAutomation(
  rule: AutomationRule,
  actorId: string
): Promise<void> {
  await setDoc(doc(db, LIVE_COLLECTIONS.automations, rule.id), {
    ...rule,
    updatedAt: new Date().toISOString(),
    updatedBy: actorId
  }, { merge: true });
}

export async function createCloudLiveRequest(request: LiveRequest): Promise<void> {
  await queueLiveSync({
    organizationId: request.organizationId,
    venueId: request.venueId,
    entityKind: 'request',
    entityId: request.id,
    payload: { ...request },
    origin: request.kind === 'section' ? 'conductor' : 'pastor',
    actorId: request.actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export async function resolveCloudLiveRequest(input: {
  request: LiveRequest;
  status: LiveRequest['status'];
  actorId: string;
}): Promise<void> {
  const transitioned = transitionLiveRequest(
    input.request,
    input.status,
    input.actorId
  );
  await queueLiveSync({
    organizationId: transitioned.organizationId,
    venueId: transitioned.venueId,
    entityKind: 'request',
    entityId: transitioned.id,
    payload: { ...transitioned },
    origin: 'live-ui',
    actorId: input.actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}

export function subscribeCloudLiveRequests(
  organizationId: string,
  liveSessionId: string,
  onChange: (requests: LiveRequest[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, LIVE_COLLECTIONS.requests),
    where('organizationId', '==', organizationId)
  );

  return onSnapshot(q, snapshot => {
    const requests = snapshot.docs
      .map(item => {
        const data = item.data() as Record<string, unknown>;
        observeRemote('request', item.id, data);
        return stripRemoteSync<LiveRequest>(data);
      })
      .filter(item => item.liveSessionId === liveSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    onChange(requests);
  }, error => onError?.(error));
}

export async function upsertCloudPresence(presence: LivePresence): Promise<void> {
  await queueLiveSync({
    organizationId: presence.organizationId,
    venueId: presence.venueId,
    liveSystemId: presence.liveSystemId,
    entityKind: 'presence',
    entityId: presence.id,
    payload: { ...presence },
    origin: presence.role === 'pastor'
      ? 'pastor'
      : presence.role === 'conductor'
        ? 'conductor'
        : 'live-ui',
    actorId: presence.actorId,
    conflictPolicy: 'last-write-wins'
  });
  await liveSyncEngine.flush();
}

export function subscribeCloudPresence(
  organizationId: string,
  liveSessionId: string,
  onChange: (presence: LivePresence[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, LIVE_COLLECTIONS.presence),
    where('organizationId', '==', organizationId)
  );

  return onSnapshot(q, snapshot => {
    const items = snapshot.docs
      .map(item => {
        const data = item.data() as Record<string, unknown>;
        observeRemote('presence', item.id, data);
        return stripRemoteSync<LivePresence>(data);
      })
      .filter(item => item.liveSessionId === liveSessionId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    onChange(items);
  }, error => onError?.(error));
}

export function subscribeCloudServicePlan(
  organizationId: string,
  planId: string,
  onChange: (plan: ServicePlan | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, LIVE_COLLECTIONS.servicePlans, planId),
    snapshot => {
      if (!snapshot.exists()) {
        onChange(null);
        return;
      }
      const data = snapshot.data() as Record<string, unknown>;
      const plan = stripRemoteSync<ServicePlan>(data);
      if (plan.organizationId !== organizationId) {
        onChange(null);
        return;
      }
      observeRemote('servicePlan', snapshot.id, data);
      onChange(plan);
    },
    error => onError?.(error)
  );
}

export async function listCloudChangeHistory(
  organizationId: string,
  maxEntries = 100
): Promise<LiveChangeHistoryRecord[]> {
  const snapshot = await getDocs(query(
    collection(db, LIVE_COLLECTIONS.changeHistory),
    where('organizationId', '==', organizationId),
    limit(Math.max(1, Math.min(250, maxEntries)))
  ));

  return snapshot.docs
    .map(item => item.data() as LiveChangeHistoryRecord)
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt));
}

export async function restoreCloudHistoryVersion(
  record: LiveChangeHistoryRecord,
  actorId: string
): Promise<void> {
  if (!record.payload || record.operation === 'delete') {
    throw new Error('history_version_has_no_restorable_payload');
  }

  await queueLiveSync({
    organizationId: record.organizationId,
    venueId: record.venueId,
    liveSystemId: record.liveSystemId,
    entityKind: record.entityKind,
    entityId: record.entityId,
    payload: record.payload,
    origin: 'studio',
    actorId,
    conflictPolicy: 'manual'
  });
  await liveSyncEngine.flush();
}
