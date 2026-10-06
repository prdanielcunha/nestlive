import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveDropStore } from '../src/liveDropStore';

async function* bytes(value: string) {
  yield Buffer.from(value);
}

const scope = {
  organizationId: 'org_1',
  venueId: 'venue_1',
  liveSystemId: 'system_1'
};

describe('LiveDropStore', () => {
  it('quarantines a safe upload, fingerprints it and only exposes safe metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const store = new LiveDropStore(join(dir, 'drop'));

    const asset = await store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'aviso.png',
      contentType: 'image/png',
      uploadedBy: 'user_1'
    }, bytes('not-a-real-image-but-safe-test-bytes'));

    expect(asset.status).toBe('quarantined');
    expect(asset.fileName).toBe('aviso.png');
    expect(asset.mediaType).toBe('image');
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((asset as unknown as Record<string, unknown>).storageName).toBeUndefined();

    const listed = await store.list(scope);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(asset.id);

    const state = JSON.parse(await readFile(join(dir, 'drop', 'index.json'), 'utf8'));
    expect(state.assets[0].storageName).toContain(asset.id);
  });

  it('moves an approved asset from quarantine to the ready cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const root = join(dir, 'drop');
    const store = new LiveDropStore(root);

    const asset = await store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'abertura.mp4',
      contentType: 'video/mp4',
      uploadedBy: 'user_1'
    }, bytes('video-test'));

    const ready = await store.review(asset.id, scope, 'ready', 'operator_1');
    expect(ready.status).toBe('ready');
    expect(ready.reviewedBy).toBe('operator_1');
    expect(ready.expiresAt).toBeNull();

    const resolved = await store.resolveReadyPath(asset.id, scope);
    expect(resolved.asset.status).toBe('ready');
    await expect(access(resolved.path)).resolves.toBeUndefined();
    await expect(access(join(root, 'quarantine', `${asset.id}.mp4`))).rejects.toBeTruthy();
  });

  it('rejects dangerous names, unsupported extensions and oversized uploads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const store = new LiveDropStore(join(dir, 'drop'), undefined, 4);

    await expect(store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: '../evil.png',
      contentType: 'image/png',
      uploadedBy: 'user_1'
    }, bytes('x'))).rejects.toThrow('invalid_live_drop_file_name');

    await expect(store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'payload.exe',
      contentType: 'application/octet-stream',
      uploadedBy: 'user_1'
    }, bytes('x'))).rejects.toThrow('live_drop_file_type_not_allowed');

    await expect(store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'large.png',
      contentType: 'image/png',
      uploadedBy: 'user_1'
    }, bytes('12345'))).rejects.toThrow('live_drop_file_too_large');
  });

  it('enforces scope and removes rejected content while retaining audit metadata briefly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const store = new LiveDropStore(join(dir, 'drop'));

    const asset = await store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'foto.jpg',
      contentType: 'image/jpeg',
      uploadedBy: 'user_1'
    }, bytes('image-test'));

    expect(await store.get(asset.id, {
      ...scope,
      organizationId: 'other'
    })).toBeNull();

    const rejected = await store.review(asset.id, scope, 'rejected', 'operator_1');
    expect(rejected.status).toBe('rejected');
    expect((await store.list(scope))[0]?.status).toBe('rejected');

    await expect(store.resolveReadyPath(asset.id, scope))
      .rejects.toThrow('live_drop_asset_not_ready');
  });

  it('expires approved cache entries when a ready retention window is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const root = join(dir, 'drop');
    const store = new LiveDropStore(
      root,
      undefined,
      250 * 1024 * 1024,
      {
        quarantineTtlMs: 1000,
        rejectedTtlMs: 1000,
        readyTtlMs: 25
      }
    );

    const asset = await store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'temporario.mp4',
      contentType: 'video/mp4',
      uploadedBy: 'user_1'
    }, bytes('temporary-video'));

    const ready = await store.review(asset.id, scope, 'ready', 'operator_1');
    expect(ready.expiresAt).not.toBeNull();

    const resolved = await store.resolveReadyPath(asset.id, scope);
    const expiresAt = Date.parse(String(ready.expiresAt));
    expect(await store.purgeExpired(expiresAt + 1)).toBe(1);
    expect(await store.list(scope)).toHaveLength(0);
    await expect(access(resolved.path)).rejects.toBeTruthy();
  });

  it('applies, persists and reloads safe retention presets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const root = join(dir, 'drop');
    const store = new LiveDropStore(root);

    const asset = await store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'culto.mp4',
      contentType: 'video/mp4',
      uploadedBy: 'user_1'
    }, bytes('service-video'));

    const ready = await store.review(asset.id, scope, 'ready', 'operator_1');
    expect(ready.expiresAt).toBeNull();

    const servicePolicy = await store.setRetentionPreset('service');
    expect(servicePolicy.readyTtlMs).toBe(24 * 60 * 60 * 1000);

    const relisted = await store.list(scope);
    expect(relisted[0]?.expiresAt).not.toBeNull();

    const reloaded = new LiveDropStore(root);
    expect((await reloaded.list(scope))[0]?.expiresAt).toBe(relisted[0]?.expiresAt);
    expect(reloaded.retention).toEqual(servicePolicy);

    const keepPolicy = await reloaded.setRetentionPreset('keep');
    expect(keepPolicy.readyTtlMs).toBeNull();
    expect((await reloaded.list(scope))[0]?.expiresAt).toBeNull();

    const state = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
    expect(state.version).toBe(2);
    expect(state.retention.readyTtlMs).toBeNull();
  });

  it('rejects a MIME type that conflicts with the file extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ms-live-drop-'));
    const store = new LiveDropStore(join(dir, 'drop'));

    await expect(store.upload({
      ...scope,
      nodeId: 'node_1',
      fileName: 'slide.png',
      contentType: 'video/mp4',
      uploadedBy: 'user_1'
    }, bytes('x'))).rejects.toThrow('live_drop_content_type_mismatch');
  });
});
