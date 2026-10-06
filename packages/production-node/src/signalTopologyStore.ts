import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  SignalEndpoint,
  SignalEndpointKind,
  SignalEndpointRole,
  SignalLink,
  SignalTopology,
  SignalTransportKind
} from '@millionsnest/nestlive-production-domain';

const ENDPOINT_ROLES = new Set<SignalEndpointRole>(['source', 'input', 'output']);
const ENDPOINT_KINDS = new Set<SignalEndpointKind>([
  'provider',
  'ndi',
  'screen-capture',
  'window-capture',
  'hdmi-capture',
  'spout',
  'syphon',
  'camera',
  'browser',
  'display',
  'projector',
  'led',
  'stream',
  'recording',
  'other'
]);
const TRANSPORT_KINDS = new Set<SignalTransportKind>([
  'internal',
  'ndi',
  'screen-capture',
  'window-capture',
  'hdmi',
  'spout',
  'syphon',
  'network',
  'other'
]);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;

function optionalText(value: unknown, max = 240): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('invalid_signal_topology');
  const next = value.trim();
  if (!next || next.length > max) throw new Error('invalid_signal_topology');
  return next;
}

function normalizeEndpoint(value: unknown): SignalEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_signal_endpoint');
  }
  const item = value as Record<string, unknown>;
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim();
  const role = String(item.role || '') as SignalEndpointRole;
  const kind = String(item.kind || '') as SignalEndpointKind;

  if (!ID_PATTERN.test(id) || !name || name.length > 96) {
    throw new Error('invalid_signal_endpoint');
  }
  if (!ENDPOINT_ROLES.has(role) || !ENDPOINT_KINDS.has(kind)) {
    throw new Error('invalid_signal_endpoint');
  }

  return {
    id,
    name,
    role,
    kind,
    nodeId: optionalText(item.nodeId, 128),
    providerId: optionalText(item.providerId, 160),
    externalRef: optionalText(item.externalRef, 320),
    notes: optionalText(item.notes, 500),
    enabled: item.enabled !== false
  };
}

function normalizeLink(value: unknown): SignalLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_signal_link');
  }
  const item = value as Record<string, unknown>;
  const id = String(item.id || '').trim();
  const fromEndpointId = String(item.fromEndpointId || '').trim();
  const toEndpointId = String(item.toEndpointId || '').trim();
  const transport = String(item.transport || '') as SignalTransportKind;

  if (
    !ID_PATTERN.test(id) ||
    !ID_PATTERN.test(fromEndpointId) ||
    !ID_PATTERN.test(toEndpointId) ||
    fromEndpointId === toEndpointId ||
    !TRANSPORT_KINDS.has(transport)
  ) {
    throw new Error('invalid_signal_link');
  }

  return {
    id,
    fromEndpointId,
    toEndpointId,
    transport,
    label: optionalText(item.label, 120),
    enabled: item.enabled !== false
  };
}

export function validateSignalTopology(value: unknown): {
  endpoints: SignalEndpoint[];
  links: SignalLink[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_signal_topology');
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.endpoints) || !Array.isArray(candidate.links)) {
    throw new Error('invalid_signal_topology');
  }
  if (candidate.endpoints.length > 64 || candidate.links.length > 128) {
    throw new Error('signal_topology_limit_exceeded');
  }

  const endpoints = candidate.endpoints.map(normalizeEndpoint);
  const links = candidate.links.map(normalizeLink);
  const endpointIds = new Set<string>();
  for (const endpoint of endpoints) {
    if (endpointIds.has(endpoint.id)) throw new Error('duplicate_signal_endpoint');
    endpointIds.add(endpoint.id);
  }

  const linkIds = new Set<string>();
  const byId = new Map(endpoints.map(endpoint => [endpoint.id, endpoint]));
  for (const link of links) {
    if (linkIds.has(link.id)) throw new Error('duplicate_signal_link');
    linkIds.add(link.id);
    const from = byId.get(link.fromEndpointId);
    const to = byId.get(link.toEndpointId);
    if (!from || !to) throw new Error('signal_link_endpoint_missing');
    if (from.role === 'output' || to.role === 'source') {
      throw new Error('invalid_signal_direction');
    }
  }

  return { endpoints, links };
}

export class SignalTopologyStore {
  private loaded = false;
  private topology: SignalTopology = {
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    links: []
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<SignalTopology> {
    if (this.loaded) return structuredClone(this.topology);
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SignalTopology;
      const normalized = validateSignalTopology(parsed);
      this.topology = {
        revision: Number.isInteger(parsed.revision) && parsed.revision >= 0
          ? parsed.revision
          : 0,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date(0).toISOString(),
        ...normalized
      };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
    return structuredClone(this.topology);
  }

  async replace(value: unknown): Promise<SignalTopology> {
    const normalized = validateSignalTopology(value);
    let result!: SignalTopology;

    this.writeQueue = this.writeQueue.then(async () => {
      await this.load();
      this.topology = {
        revision: this.topology.revision + 1,
        updatedAt: new Date().toISOString(),
        ...normalized
      };
      await this.persist();
      result = structuredClone(this.topology);
    });
    await this.writeQueue;
    return result;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.topology, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
