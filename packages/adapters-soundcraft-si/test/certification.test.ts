import { describe, expect, it } from 'vitest';
import {
  certifiedCapabilities,
  createEmptySoundcraftManifest,
  SoundcraftSiProvider
} from '../src';

describe('Soundcraft physical certification gate', () => {
  it('exposes no untested capabilities', () => {
    const manifest = createEmptySoundcraftManifest();
    expect([...certifiedCapabilities(manifest)]).toEqual([]);
  });

  it('exposes read-only capabilities without inventing writes', () => {
    const manifest = createEmptySoundcraftManifest();
    const channelRead = manifest.capabilities.find(
      item => item.capability === 'audio.channel.read'
    )!;
    channelRead.status = 'read_only';

    const fader = manifest.capabilities.find(
      item => item.capability === 'audio.fader.write'
    )!;
    fader.status = 'read_only';

    expect([...certifiedCapabilities(manifest)]).toContain('audio.channel.read');
    expect([...certifiedCapabilities(manifest)]).not.toContain('audio.fader.write');
  });

  it('blocks provider operations not physically certified', async () => {
    const manifest = createEmptySoundcraftManifest();
    const provider = new SoundcraftSiProvider(
      'soundcraft-industrial',
      {
        async getConsoleState() {
          throw new Error('should_not_run');
        },
        async getChannels() {
          return [];
        },
        async getBuses() {
          return [];
        },
        async getGroups() {
          return [];
        }
      },
      manifest
    );

    await expect(provider.getChannels()).rejects.toThrow(
      'soundcraft_capability_not_certified'
    );
  });
});
