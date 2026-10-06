import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  publicAdapterConfig,
  validateAdapterRegistration,
  type AdapterManifest,
  type AdapterSdkRegistration,
  type ProductionAdapterKey
} from '@millionsnest/nestlive-production-domain';
import {
  PlaintextAlphaSecretProtector,
  type SecretProtector
} from './secretProtector';

export interface ProductionProviderConfig {
  instanceId: string;
  adapterKey: ProductionAdapterKey;
  displayName: string;
  config: Record<string, unknown>;
  updatedAt: string;
}

interface StoredProductionProviderConfig extends ProductionProviderConfig {}

interface ProductionProviderConfigFile {
  version: 1;
  providers: StoredProductionProviderConfig[];
}

const EMPTY_FILE: ProductionProviderConfigFile = {
  version: 1,
  providers: []
};

function normalizeHost(value: unknown): string {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('production_host_required');

  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (!local) throw new Error('production_host_must_be_local');
  return host;
}

function normalizeUrl(value: unknown): string {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('production_url_protocol_invalid');
  }
  normalizeHost(parsed.hostname);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('production_port_invalid');
  }
  return port;
}

function purpose(instanceId: string, key: string): string {
  return `production.${instanceId}.${key}`;
}

export class ProductionProviderConfigStore {
  private loaded = false;
  private file: ProductionProviderConfigFile = structuredClone(EMPTY_FILE);

  constructor(
    private readonly filePath: string,
    private readonly secretProtector: SecretProtector = new PlaintextAlphaSecretProtector()
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ProductionProviderConfigFile;
      this.file =
        parsed.version === 1 && Array.isArray(parsed.providers)
          ? parsed
          : structuredClone(EMPTY_FILE);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.file = structuredClone(EMPTY_FILE);
    }
    this.loaded = true;
  }

  async upsert(
    manifest: AdapterManifest,
    input: Omit<ProductionProviderConfig, 'adapterKey' | 'updatedAt'>
  ): Promise<ProductionProviderConfig> {
    await this.load();

    const instanceId = input.instanceId.trim();
    const existing = this.file.providers.find(
      item => item.instanceId === instanceId
    );
    if (existing && existing.adapterKey !== manifest.adapterKey) {
      throw new Error('adapter_instance_kind_conflict');
    }

    const registration: AdapterSdkRegistration = {
      manifest,
      instanceId,
      displayName: input.displayName.trim(),
      config: {
        ...(existing?.config || {}),
        ...input.config
      }
    };
    validateAdapterRegistration(registration);

    const normalized: Record<string, unknown> = {};
    for (const field of manifest.setup) {
      const raw = registration.config[field.key];
      if (raw === undefined || raw === null || raw === '') continue;

      let value: unknown = raw;
      if (field.kind === 'host') value = normalizeHost(raw);
      else if (field.kind === 'url') value = normalizeUrl(raw);
      else if (field.kind === 'port') value = normalizePort(raw);
      else if (field.kind === 'number') {
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new Error(`production_number_invalid:${field.key}`);
        value = number;
      } else if (field.kind === 'boolean') {
        value = raw === true || raw === 'true';
      } else if (field.kind === 'secret' || field.secret) {
        const secret = String(raw);
        if (!secret) throw new Error(`production_secret_required:${field.key}`);
        value = this.secretProtector.isProtected(secret)
          ? secret
          : await this.secretProtector.protect(
              secret,
              purpose(registration.instanceId, field.key)
            );
      } else {
        value = String(raw).trim();
      }
      normalized[field.key] = value;
    }

    if (existing) {
      for (const field of manifest.setup.filter(field => field.secret || field.kind === 'secret')) {
        const current = existing.config[field.key];
        const next = normalized[field.key];
        if (next === undefined && current !== undefined) {
          normalized[field.key] = current;
        } else if (
          typeof current === 'string' &&
          next !== current &&
          this.secretProtector.isProtected(current)
        ) {
          await this.secretProtector.delete(
            current,
            purpose(registration.instanceId, field.key)
          );
        }
      }
    }

    const stored: StoredProductionProviderConfig = {
      instanceId: registration.instanceId,
      adapterKey: manifest.adapterKey,
      displayName: registration.displayName,
      config: normalized,
      updatedAt: new Date().toISOString()
    };

    this.file.providers = this.file.providers
      .filter(item => item.instanceId !== stored.instanceId);
    this.file.providers.push(stored);
    await this.persist();

    return this.resolve(stored, manifest);
  }

  async allResolved(
    manifests: Record<string, AdapterManifest>
  ): Promise<ProductionProviderConfig[]> {
    await this.load();
    const byKey = new Map(
      Object.values(manifests).map(manifest => [manifest.adapterKey, manifest])
    );

    const output: ProductionProviderConfig[] = [];
    for (const stored of this.file.providers) {
      const manifest = byKey.get(stored.adapterKey);
      if (!manifest) continue;
      output.push(await this.resolve(stored, manifest));
    }
    return output.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async allPublic(
    manifests: Record<string, AdapterManifest>
  ): Promise<ProductionProviderConfig[]> {
    const resolved = await this.allResolved(manifests);
    const byKey = new Map(
      Object.values(manifests).map(manifest => [manifest.adapterKey, manifest])
    );

    return resolved.map(item => {
      const manifest = byKey.get(item.adapterKey)!;
      return {
        ...item,
        config: publicAdapterConfig({
          manifest,
          instanceId: item.instanceId,
          displayName: item.displayName,
          config: item.config
        })
      };
    });
  }

  async remove(
    instanceId: string,
    manifests: Record<string, AdapterManifest>
  ): Promise<boolean> {
    await this.load();
    const existing = this.file.providers.find(item => item.instanceId === instanceId);
    if (!existing) return false;

    const manifest = Object.values(manifests)
      .find(candidate => candidate.adapterKey === existing.adapterKey);

    if (manifest) {
      for (const field of manifest.setup.filter(field => field.secret || field.kind === 'secret')) {
        const value = existing.config[field.key];
        if (typeof value === 'string') {
          await this.secretProtector.delete(
            value,
            purpose(existing.instanceId, field.key)
          );
        }
      }
    }

    this.file.providers = this.file.providers.filter(item => item.instanceId !== instanceId);
    await this.persist();
    return true;
  }

  private async resolve(
    stored: StoredProductionProviderConfig,
    manifest: AdapterManifest
  ): Promise<ProductionProviderConfig> {
    const config = { ...stored.config };
    for (const field of manifest.setup.filter(field => field.secret || field.kind === 'secret')) {
      const value = config[field.key];
      if (typeof value === 'string') {
        config[field.key] = await this.secretProtector.unprotect(
          value,
          purpose(stored.instanceId, field.key)
        );
      }
    }

    return {
      ...structuredClone(stored),
      config
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.file, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
}
