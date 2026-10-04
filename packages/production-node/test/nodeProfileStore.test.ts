import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeProfileStore } from '../src/nodeProfileStore';

const dirs: string[] = [];

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'ms-live-profile-'));
  dirs.push(dir);
  return {
    dir,
    path: join(dir, 'profile.json'),
    store: new NodeProfileStore(join(dir, 'profile.json'), 'Projection PC')
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('NodeProfileStore', () => {
  it('starts with the OS-facing fallback and persists a human name', async () => {
    const value = await makeStore();
    expect((await value.store.load()).displayName).toBe('Projection PC');

    const updated = await value.store.setDisplayName('  PC   do Telão  ');
    expect(updated.displayName).toBe('PC do Telão');

    const restarted = new NodeProfileStore(value.path, 'Other Host');
    expect((await restarted.load()).displayName).toBe('PC do Telão');
  });

  it('bounds names and strips control characters', async () => {
    const value = await makeStore();
    const updated = await value.store.setDisplayName(
      'Projeção\nPrincipal ' + 'X'.repeat(100)
    );
    expect(updated.displayName).not.toContain('\n');
    expect(updated.displayName.length).toBeLessThanOrEqual(64);
  });

  it('writes profile data with no pairing or provider secrets', async () => {
    const value = await makeStore();
    await value.store.setDisplayName('Arena Visual');
    await value.store.markTutorialComplete();

    const raw = await readFile(value.path, 'utf8');
    expect(raw).toContain('Arena Visual');
    expect(raw).not.toMatch(/token|password|secret|pairing/i);
  });
});
