export const CAPABILITIES = [
  'presentation.slides.read',
  'presentation.navigation',
  'presentation.preview',
  'presentation.take',
  'presentation.clear',
  'presentation.screen.mode',
  'presentation.background.read',
  'presentation.background.set',
  'bible.search',
  'bible.versions.read',
  'bible.books.read',
  'bible.present',
  'text.search',
  'text.present',
  'text.quick.present',
  'announcement.read',
  'announcement.present',
  'songs.search',
  'songs.create',
  'songs.present',
  'playlist.write',
  'playlist.sync',
  'media.search',
  'media.open',
  'preview.snapshot',
  'stage.message',
  'visual.composition.read',
  'visual.clip.trigger',
  'visual.layer.clear',
  'visual.composition.clear',
  'visual.outputs.read',
  'visual.output.snapshot',
  'visual.clip.thumbnail',
  'audio.route.read',
  'audio.route.write',
  'automation.trigger'
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type ProviderKind =
  | 'presentation'
  | 'bible'
  | 'visual'
  | 'broadcast'
  | 'stage'
  | 'audio'
  | 'control';

export type ProviderHealth = 'online' | 'degraded' | 'reconnecting' | 'offline' | 'manual';

export type SafetyLevel = 'normal' | 'guarded' | 'critical';

export type CommandOrigin =
  | 'live-ui'
  | 'pastor'
  | 'conductor'
  | 'automation'
  | 'api';

export interface ProviderDescriptor {
  id: string;
  nodeId: string;
  kind: ProviderKind;
  displayName: string;
  providerKey: string;
  version?: string;
}

export interface ProviderState {
  health: ProviderHealth;
  updatedAt: string;
  observed: Record<string, unknown>;
}

export interface LiveCommand<TPayload = Record<string, unknown>> {
  id: string;
  correlationId: string;
  organizationId: string;
  venueId: string;
  liveSystemId: string;
  liveSessionId: string;
  serviceItemId?: string;
  actorId: string;
  origin: CommandOrigin;
  capability: Capability;
  targetProviderIds: string[];
  outputTargets: string[];
  payload: TPayload;
  idempotencyKey: string;
  createdAt: string;
  safetyLevel: SafetyLevel;
}

export interface CommandResult {
  commandId: string;
  providerInstanceId: string;
  accepted: boolean;
  observedState?: Record<string, unknown>;
  latencyMs: number;
  errorCode?: string;
  recoverable?: boolean;
}

export interface LiveEvent<TPayload = Record<string, unknown>> {
  id: string;
  correlationId: string;
  type: string;
  occurredAt: string;
  source: string;
  payload: TPayload;
}

export interface LiveSessionEvent<TPayload = Record<string, unknown>>
  extends LiveEvent<TPayload> {
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  liveSessionId: EntityId;
  actorId?: EntityId;
  serviceItemId?: EntityId;
  origin?: CommandOrigin;
  level: 'info' | 'warning' | 'error';
}

export interface LiveSessionEventSummary {
  total: number;
  info: number;
  warnings: number;
  errors: number;
  plannedActions: number;
  plannedServiceItems: number;
  adHocActions: number;
  byType: Record<string, number>;
  providerCommandResults: number;
  providerCommandAccepted: number;
  providerCommandRejected: number;
  providerLatencySamples: number;
  providerLatencyP50Ms?: number;
  providerLatencyP95Ms?: number;
  providerLatencyMaxMs?: number;
  startedAt?: string;
  lastEventAt?: string;
}

export interface LiveSessionEventPage {
  events: LiveSessionEvent[];
  total: number;
  liveSessionId?: EntityId;
  summary: LiveSessionEventSummary;
}

export interface CapabilitySnapshot {
  providerId: string;
  capabilities: Capability[];
  health: ProviderHealth;
  observed?: Record<string, unknown>;
}


export type EntityId = string;

export interface Venue {
  id: EntityId;
  organizationId: EntityId;
  name: string;
  timeZone: string;
  active: boolean;
}

export interface LiveSystem {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  name: string;
  activeProfileId?: EntityId | null;
}

export interface LiveNodeRecord {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  displayName: string;
  platform: 'windows' | 'macos' | 'linux' | 'unknown';
  status: ProviderHealth;
  lastSeenAt?: string | null;
  pairedAt?: string | null;
}

export interface ProviderInstance {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  nodeId: EntityId;
  providerKey: string;
  displayName: string;
  kinds: ProviderKind[];
  version?: string;
  capabilities: Capability[];
  health: ProviderHealth;
}

export type OutputTargetKind =
  | 'main'
  | 'stage'
  | 'confidence'
  | 'broadcast'
  | 'foyer'
  | 'side_left'
  | 'side_right'
  | 'recording'
  | 'custom';

export interface OutputTarget {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  kind: OutputTargetKind;
  name: string;
  active: boolean;
}

/**
 * Describes the physical/media plane without turning the Live Node into a
 * video transport engine. These endpoints are operational metadata used by
 * Studio/Diagnostics to explain how signal actually travels through a room.
 */
export type SignalEndpointRole = 'source' | 'input' | 'output';

export type SignalEndpointKind =
  | 'provider'
  | 'ndi'
  | 'screen-capture'
  | 'window-capture'
  | 'hdmi-capture'
  | 'spout'
  | 'syphon'
  | 'camera'
  | 'browser'
  | 'display'
  | 'projector'
  | 'led'
  | 'stream'
  | 'recording'
  | 'other';

export type SignalTransportKind =
  | 'internal'
  | 'ndi'
  | 'screen-capture'
  | 'window-capture'
  | 'hdmi'
  | 'spout'
  | 'syphon'
  | 'network'
  | 'other';

export interface SignalEndpoint {
  id: EntityId;
  name: string;
  role: SignalEndpointRole;
  kind: SignalEndpointKind;
  nodeId?: EntityId;
  providerId?: EntityId;
  externalRef?: string;
  notes?: string;
  enabled: boolean;
}

export interface SignalLink {
  id: EntityId;
  fromEndpointId: EntityId;
  toEndpointId: EntityId;
  transport: SignalTransportKind;
  label?: string;
  enabled: boolean;
}

export interface SignalTopology {
  revision: number;
  updatedAt: string;
  endpoints: SignalEndpoint[];
  links: SignalLink[];
}

export type RouteContentType =
  | 'lyrics'
  | 'bible'
  | 'announcements'
  | 'media'
  | 'stage'
  | 'broadcast'
  | 'custom';

export interface Route {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  name: string;
  contentTypes: RouteContentType[];
  sourceProviderIds: EntityId[];
  processorProviderIds: EntityId[];
  outputTargetIds: EntityId[];
  enabled: boolean;
}

export interface LiveProfile {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  name: string;
  routeIds: EntityId[];
  outputTargetIds: EntityId[];
  providerInstanceIds: EntityId[];
}

export type ServiceItemType =
  | 'song'
  | 'bible'
  | 'video'
  | 'image'
  | 'audio'
  | 'text'
  | 'announcement'
  | 'presentation'
  | 'action'
  | 'macro'
  | 'scene'
  | 'custom';

export type ServiceItemState =
  | 'planned'
  | 'prepared'
  | 'live'
  | 'completed'
  | 'skipped'
  | 'warning'
  | 'error';

export interface ServiceItem {
  id: EntityId;
  type: ServiceItemType;
  title: string;
  plannedDurationSeconds?: number;
  plannedStartAt?: string;
  responsibleUserId?: EntityId;
  sourceEntityId?: EntityId;
  providerLinkId?: EntityId;
  state: ServiceItemState;
  payload?: Record<string, unknown>;
}

export interface ServicePlan {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  sourceMusicScaleId?: EntityId;
  title: string;
  scheduledAt: string;
  metadata?: Record<string, unknown>;
  profileId?: EntityId;
  items: ServiceItem[];
  revision: number;
}

export interface LiveSession {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  servicePlanId: EntityId;
  startedAt: string;
  endedAt?: string;
  status: 'preflight' | 'live' | 'ended' | 'aborted';
  activeServiceItemId?: EntityId | null;
}

export interface ProviderLink {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  providerInstanceId: EntityId;
  entityType: string;
  musicScaleEntityId?: EntityId;
  externalId: string;
  fingerprint?: string;
  lastVerifiedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SceneAction {
  id: EntityId;
  capability: Capability;
  targetProviderIds: EntityId[];
  outputTargets: EntityId[];
  payload: Record<string, unknown>;
  safetyLevel: SafetyLevel;
  /**
   * Relative delay from the scene start. Allows tightly coordinated provider
   * transitions without leaking provider-specific sequencing into the domain.
   */
  offsetMs?: number;
}

export interface Scene {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId?: EntityId;
  name: string;
  actions: SceneAction[];
}

export interface SceneExecutionRequest {
  id: EntityId;
  correlationId: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  liveSessionId: EntityId;
  serviceItemId?: EntityId;
  actorId: EntityId;
  origin: CommandOrigin;
  scene: Scene;
  idempotencyKey: string;
}

export interface SceneActionExecutionResult {
  actionId: EntityId;
  offsetMs: number;
  results: CommandResult[];
}

export interface SceneExecutionResult {
  sceneId: EntityId;
  correlationId: EntityId;
  status: 'completed' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string;
  actions: SceneActionExecutionResult[];
}

export interface AutomationRule {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: Array<Record<string, unknown>>;
  actions: SceneAction[];
}

export interface MediaAsset {
  id: EntityId;
  organizationId: EntityId;
  venueId?: EntityId;
  name: string;
  mediaType: 'image' | 'video' | 'audio' | 'pdf' | 'presentation' | 'other';
  locations: Array<{
    kind: 'cloud' | 'node' | 'provider';
    ref: string;
  }>;
}

export type LiveDropStatus = 'quarantined' | 'ready' | 'rejected';

export interface LiveDropAsset {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  nodeId: EntityId;
  fileName: string;
  mediaType: MediaAsset['mediaType'];
  contentType: string;
  sizeBytes: number;
  sha256: string;
  status: LiveDropStatus;
  uploadedAt: string;
  uploadedBy: EntityId;
  reviewedAt?: string | null;
  reviewedBy?: EntityId | null;
  expiresAt?: string | null;
}

export type LiveChatSenderContext =
  | 'operator'
  | 'pastor'
  | 'conductor'
  | 'team';

export type LiveChatAudience =
  | 'team'
  | 'operator'
  | 'pastor'
  | 'conductor'
  | 'production';

export interface LiveChatMessage {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  liveSessionId: EntityId;
  actorId: EntityId;
  senderContext: LiveChatSenderContext;
  audience: LiveChatAudience;
  text: string;
  createdAt: string;
  replyToId?: EntityId;
  relatedRequestId?: EntityId;
  relatedServiceItemId?: EntityId;
}

export type RequestKind = 'bible' | 'song' | 'section' | 'media' | 'message';

export type LiveRequestStatus =
  | 'sent'
  | 'seen'
  | 'accepted'
  | 'prepared'
  | 'executed'
  | 'rejected';

export type LiveRequestPriority = 'normal' | 'urgent';

export interface LiveRequest {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSessionId: EntityId;
  actorId: EntityId;
  kind: RequestKind;
  payload: Record<string, unknown>;
  status: LiveRequestStatus;
  priority?: LiveRequestPriority;
  createdAt: string;
  updatedAt?: string;
  seenAt?: string;
  acceptedAt?: string;
  preparedAt?: string;
  executedAt?: string;
  rejectedAt?: string;
  resolvedAt?: string;
  resolvedBy?: EntityId;
}

export type LiveCollaborationRole = 'pastor' | 'conductor' | 'viewer';

export interface LiveCollaborationInvite {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId: EntityId;
  liveSessionId: EntityId;
  role: LiveCollaborationRole;
  createdBy: EntityId;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revokedAt?: string;
}

export interface LiveCollaborationGrant {
  inviteId: EntityId;
  liveSessionId: EntityId;
  role: LiveCollaborationRole;
  actorId: EntityId;
  expiresAt: string;
  permissions: Array<
    | 'request.bible'
    | 'request.song'
    | 'request.section'
    | 'request.media'
    | 'request.message'
    | 'presence.write'
    | 'chat.write'
  >;
}


export type SyncEntityKind =
  | 'servicePlan'
  | 'providerLink'
  | 'scene'
  | 'request'
  | 'presence'
  | 'liveConfig'
  | 'route'
  | 'signalTopology'
  | 'audioProfile'
  | 'template';

export type SyncStatus =
  | 'local'
  | 'pending'
  | 'synced'
  | 'offline'
  | 'conflict'
  | 'failed';

export type SyncMutationOperation = 'upsert' | 'delete';

export type SyncConflictPolicy =
  | 'manual'
  | 'last-write-wins'
  | 'append-only';

export interface SyncMutation<TPayload = Record<string, unknown>> {
  id: EntityId;
  organizationId: EntityId;
  venueId?: EntityId;
  liveSystemId?: EntityId;
  entityKind: SyncEntityKind;
  entityId: EntityId;
  operation: SyncMutationOperation;
  payload?: TPayload;
  baseVersion?: string | null;
  version: string;
  origin: 'studio' | 'live-ui' | 'pastor' | 'conductor' | 'live-node' | 'system';
  actorId: EntityId;
  createdAt: string;
  attempt: number;
  nextAttemptAt?: string;
  conflictPolicy: SyncConflictPolicy;
}

export interface SyncConflict<TPayload = Record<string, unknown>> {
  mutation: SyncMutation<TPayload>;
  remoteVersion?: string | null;
  remotePayload?: TPayload | null;
  detectedAt: string;
}

export interface EntitySyncState {
  key: string;
  entityKind: SyncEntityKind;
  entityId: EntityId;
  status: SyncStatus;
  mutationId?: EntityId;
  version?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface CloudVersionEnvelope<TPayload = Record<string, unknown>> {
  data: TPayload;
  _sync: {
    version: string;
    mutationId: EntityId;
    actorId: EntityId;
    origin: SyncMutation['origin'];
    updatedAt: string;
  };
}


export type LivePresenceRole =
  | 'operator'
  | 'pastor'
  | 'conductor'
  | 'viewer';

export interface LivePresence {
  id: EntityId;
  organizationId: EntityId;
  venueId: EntityId;
  liveSystemId?: EntityId;
  liveSessionId: EntityId;
  actorId: EntityId;
  role: LivePresenceRole;
  deviceName?: string;
  active: boolean;
  lastSeenAt: string;
}
