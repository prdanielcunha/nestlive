import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderConfigStore } from '../src/providerConfigStore';
import type { SecretProtector } from '../src/secretProtector';

class TestSecretProtector implements SecretProtector {
  readonly kind = 'windows-dpapi' as const;
  deleted: Array<{ value: string; purpose: string }> = [];

  isProtected(value: string): boolean {
    return value.startsWith('test:v1:');
  }

  async protect(value: string): Promise<string> {
    return `test:v1:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  async unprotect(value: string): Promise<string> {
    if (!this.isProtected(value)) return value;
    return Buffer.from(value.slice('test:v1:'.length), 'base64').toString('utf8');
  }

  async delete(value: string, purpose: string): Promise<void> {
    this.deleted.push({ value, purpose });
  }
}

describe('ProviderConfigStore', () => {
  it('stores Holyrics configuration only in the local Node state directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');
    const store = new ProviderConfigStore(path);

    await store.setHolyrics({
      baseUrl: 'http://127.0.0.1:8091',
      token: 'local-token'
    });

    const restored = new ProviderConfigStore(path);
    expect((await restored.getHolyrics())?.token).toBe('local-token');
    expect(await readFile(path, 'utf8')).toContain('local-token');
  });

  it('keeps the Holyrics token out of plaintext provider config when protection is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');
    const store = new ProviderConfigStore(path, new TestSecretProtector());

    await store.setHolyrics({
      baseUrl: 'http://127.0.0.1:8091',
      token: 'super-secret-token'
    });

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).toContain('test:v1:');

    const restored = new ProviderConfigStore(path, new TestSecretProtector());
    expect((await restored.getHolyrics())?.token).toBe('super-secret-token');
  });

  it('migrates a legacy plaintext Holyrics token when a protected backend becomes available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');

    const legacy = new ProviderConfigStore(path);
    await legacy.setHolyrics({
      baseUrl: 'http://127.0.0.1:8091',
      token: 'legacy-token'
    });
    expect(await readFile(path, 'utf8')).toContain('legacy-token');

    const protectedStore = new ProviderConfigStore(path, new TestSecretProtector());
    expect((await protectedStore.getHolyrics())?.token).toBe('legacy-token');

    const migrated = await readFile(path, 'utf8');
    expect(migrated).not.toContain('legacy-token');
    expect(migrated).toContain('test:v1:');
  });

  it('removes the protected token from the external store when Holyrics is cleared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');
    const protector = new TestSecretProtector();
    const store = new ProviderConfigStore(path, protector);

    await store.setHolyrics({
      baseUrl: 'http://127.0.0.1:8091',
      token: 'secret-to-delete'
    });
    await store.clearHolyrics();

    expect(protector.deleted).toHaveLength(1);
    expect(protector.deleted[0]?.purpose).toBe('holyrics.token');
    expect(await store.getHolyrics()).toBeNull();
  });

  it('stores a local Resolume Webserver endpoint without a cloud secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');
    const store = new ProviderConfigStore(path);

    await store.setResolume({
      baseUrl: 'http://192.168.1.50:8080'
    });

    const restored = new ProviderConfigStore(path);
    expect((await restored.getResolume())?.baseUrl).toBe('http://192.168.1.50:8080');
    expect(await readFile(path, 'utf8')).toContain('192.168.1.50:8080');
  });

  it('stores a local ProPresenter API endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const path = join(dir, 'providers.json');
    const store = new ProviderConfigStore(path);

    await store.setProPresenter({
      baseUrl: 'http://192.168.1.60:50001'
    });

    const restored = new ProviderConfigStore(path);
    expect((await restored.getProPresenter())?.baseUrl)
      .toBe('http://192.168.1.60:50001');
  });

  it('rejects public internet ProPresenter endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const store = new ProviderConfigStore(join(dir, 'providers.json'));

    await expect(store.setProPresenter({
      baseUrl: 'https://example.com'
    })).rejects.toThrow('propresenter_url_must_be_local');
  });

  it('rejects public internet Resolume endpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const store = new ProviderConfigStore(join(dir, 'providers.json'));

    await expect(store.setResolume({
      baseUrl: 'https://example.com'
    })).rejects.toThrow('resolume_url_must_be_local');
  });

  it('rejects public internet Holyrics endpoints for local provider setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-provider-'));
    const store = new ProviderConfigStore(join(dir, 'providers.json'));

    await expect(store.setHolyrics({
      baseUrl: 'https://example.com',
      token: 'token'
    })).rejects.toThrow('holyrics_url_must_be_local');
  });
});
