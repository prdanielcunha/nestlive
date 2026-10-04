import type {
  CommandResult,
  LiveCommand,
  LiveRequest,
  LiveSessionEvent,
  SceneExecutionRequest,
  SceneExecutionResult
} from '@millionsnest/nestlive-production-domain';

const SUBJECT_KEYS = [
  'id',
  'title',
  'name',
  'reference',
  'references',
  'file',
  'action',
  'index',
  'initialIndex',
  'mode',
  'kind',
  'message',
  'text'
] as const;

function compactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map(item => compactValue(item))
      .filter(item => item !== undefined);
  }
  return undefined;
}

function isRunOfShowAction(capability: LiveCommand['capability']): boolean {
  return [
    'songs.present',
    'bible.present',
    'media.open',
    'text.present',
    'text.quick.present',
    'announcement.present',
    'presentation.take'
  ].includes(capability);
}

function commandSubject(payload: Record<string, unknown>): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  for (const key of SUBJECT_KEYS) {
    const compact = compactValue(payload[key]);
    if (compact !== undefined && compact !== '') subject[key] = compact;
  }
  return subject;
}

export function semanticEventType(capability: LiveCommand['capability']): string {
  switch (capability) {
    case 'songs.present':
      return 'song.presented';
    case 'bible.present':
      return 'bible.presented';
    case 'media.open':
      return 'media.presented';
    case 'text.present':
    case 'text.quick.present':
      return 'text.presented';
    case 'announcement.present':
      return 'announcement.presented';
    case 'presentation.navigation':
      return 'presentation.navigated';
    case 'presentation.take':
      return 'presentation.taken';
    case 'presentation.clear':
      return 'presentation.cleared';
    case 'presentation.screen.mode':
      return 'screen.mode.changed';
    case 'presentation.background.set':
      return 'background.changed';
    case 'stage.message':
      return 'stage.message.sent';
    case 'visual.clip.trigger':
      return 'visual.clip.triggered';
    case 'visual.layer.clear':
      return 'visual.layer.cleared';
    case 'visual.composition.clear':
      return 'visual.composition.cleared';
    case 'automation.trigger':
      return 'automation.triggered';
    default:
      return 'command.completed';
  }
}

export function eventFromCommand(
  command: LiveCommand,
  results: CommandResult[]
): LiveSessionEvent {
  const accepted = results.filter(result => result.accepted);
  const failed = results.filter(result => !result.accepted);
  const requestedEventType = semanticEventType(command.capability);
  const runOfShowAction = isRunOfShowAction(command.capability);
  const level: LiveSessionEvent['level'] =
    accepted.length === 0
      ? 'error'
      : failed.length > 0
        ? 'warning'
        : 'info';

  return {
    id: `event:command:${command.id}`,
    correlationId: command.correlationId,
    type: accepted.length ? requestedEventType : 'command.failed',
    occurredAt: new Date().toISOString(),
    source: 'live-node',
    organizationId: command.organizationId,
    venueId: command.venueId,
    liveSystemId: command.liveSystemId,
    liveSessionId: command.liveSessionId,
    actorId: command.actorId,
    serviceItemId: command.serviceItemId,
    origin: command.origin,
    level,
    payload: {
      capability: command.capability,
      requestedEventType,
      safetyLevel: command.safetyLevel,
      planned: runOfShowAction && Boolean(command.serviceItemId),
      adHoc: runOfShowAction && !command.serviceItemId,
      outputTargets: command.outputTargets.slice(0, 12),
      targetProviderIds: command.targetProviderIds.slice(0, 12),
      subject: commandSubject(command.payload),
      acceptedCount: accepted.length,
      failedCount: failed.length,
      providers: results.slice(0, 12).map(result => ({
        providerId: result.providerInstanceId,
        accepted: result.accepted,
        latencyMs: result.latencyMs,
        errorCode: result.errorCode,
        recoverable: result.recoverable
      }))
    }
  };
}

export function eventFromRequestCreated(
  request: LiveRequest,
  liveSystemId: string
): LiveSessionEvent {
  return {
    id: `event:request:${request.id}:created`,
    correlationId: request.id,
    type: 'request.created',
    occurredAt: request.createdAt,
    source: 'live-node',
    organizationId: request.organizationId,
    venueId: request.venueId,
    liveSystemId,
    liveSessionId: request.liveSessionId,
    actorId: request.actorId,
    level: 'info',
    payload: {
      requestId: request.id,
      kind: request.kind,
      status: request.status,
      subject: commandSubject(request.payload)
    }
  };
}

export function eventFromRequestStatus(
  request: LiveRequest,
  liveSystemId: string
): LiveSessionEvent {
  const level: LiveSessionEvent['level'] =
    request.status === 'rejected' ? 'warning' : 'info';

  return {
    id: `event:request:${request.id}:status:${request.status}:${request.updatedAt || request.resolvedAt || ''}`,
    correlationId: request.id,
    type: 'request.status.changed',
    occurredAt: request.updatedAt || request.resolvedAt || new Date().toISOString(),
    source: 'live-node',
    organizationId: request.organizationId,
    venueId: request.venueId,
    liveSystemId,
    liveSessionId: request.liveSessionId,
    actorId: request.resolvedBy,
    level,
    payload: {
      requestId: request.id,
      kind: request.kind,
      status: request.status,
      resolvedBy: request.resolvedBy,
      subject: commandSubject(request.payload)
    }
  };
}

export function eventFromScene(
  request: SceneExecutionRequest,
  result: SceneExecutionResult
): LiveSessionEvent {
  return {
    id: `event:scene:${request.id}`,
    correlationId: request.correlationId,
    type: 'scene.executed',
    occurredAt: result.completedAt,
    source: 'live-node',
    organizationId: request.organizationId,
    venueId: request.venueId,
    liveSystemId: request.liveSystemId,
    liveSessionId: request.liveSessionId,
    actorId: request.actorId,
    serviceItemId: request.serviceItemId,
    origin: request.origin,
    level:
      result.status === 'completed'
        ? 'info'
        : result.status === 'partial'
          ? 'warning'
          : 'error',
    payload: {
      sceneId: request.scene.id,
      sceneName: request.scene.name,
      status: result.status,
      planned: Boolean(request.serviceItemId),
      adHoc: !request.serviceItemId,
      actionCount: result.actions.length,
      actions: result.actions.slice(0, 24).map(action => ({
        actionId: action.actionId,
        accepted: action.results.filter(item => item.accepted).length,
        failed: action.results.filter(item => !item.accepted).length
      }))
    }
  };
}
