import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_ADAPTER_MANIFESTS } from '@millionsnest/nestlive-adapters-production';
import { ProductionProviderConfigStore } from '../src/productionProviderConfigStore';
import type { SecretProtector } from '../src/secretProtector';

class TestProtector implements SecretProtector {
  readonly kind = 'windows-dpapi' as const;
  isProtected(value: string) {
    return value.startsWith('protected:');
  }
  async protect(value: string) {
    return `protected:${Buffer.from(value, 'utf8').toString('base64url')}`;
  }
  async unprotect(value: string) {
    const encoded = value.replace(/^protected:/, '');
    return Buffer.from(encoded, 'base64url').toString('utf8');
  }
  async delete() {}
}

describe('ProductionProviderConfigStore', () => {
  it('stores secrets protected and resolves them only for runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-production-config-'));
    const path = join(dir, 'production-providers.json');
    const store = new ProductionProviderConfigStore(path, new TestProtector());

    const value = await store.upsert(PRODUCTION_ADAPTER_MANIFESTS.obs, {
      instanceId: 'obs-main',
      displayName: 'OBS principal',
      config: {
        url: 'ws://127.0.0.1:4455',
        password: 'my-password'
      }
    });

    expect(value.config.password).toBe('my-password');
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('my-password');
    const stored = JSON.parse(persisted) as {
      providers: Array<{ config: Record<string, unknown> }>;
    };
    expect(String(stored.providers[0]?.config.password || '')).toMatch(/^protected:/);

    const publicList = await store.allPublic(PRODUCTION_ADAPTER_MANIFESTS);
    expect(publicList[0]?.config.password).toBe('[stored-in-os-vault]');
  });

  it('rejects public internet targets for LAN production integrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-production-config-'));
    const store = new ProductionProviderConfigStore(
      join(dir, 'production-providers.json'),
      new TestProtector()
    );

    await expect(store.upsert(PRODUCTION_ADAPTER_MANIFESTS.vmix, {
      instanceId: 'vmix-cloud',
      displayName: 'Wrong target',
      config: { baseUrl: 'https://example.com' }
    })).rejects.toThrow('production_host_must_be_local');
  });

  it('preserves the existing protected secret when editing non-secret fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-production-config-'));
    const path = join(dir, 'production-providers.json');
    const store = new ProductionProviderConfigStore(path, new TestProtector());

    await store.upsert(PRODUCTION_ADAPTER_MANIFESTS.obs, {
      instanceId: 'obs-main',
      displayName: 'OBS A',
      config: { url: 'ws://127.0.0.1:4455', password: 'secret-a' }
    });
    await store.upsert(PRODUCTION_ADAPTER_MANIFESTS.obs, {
      instanceId: 'obs-main',
      displayName: 'OBS B',
      config: { url: 'ws://127.0.0.1:4456' }
    });

    const resolved = await store.allResolved(PRODUCTION_ADAPTER_MANIFESTS);
    expect(resolved[0]?.displayName).toBe('OBS B');
    expect(resolved[0]?.config.password).toBe('secret-a');
  });
});
