import { describe, expect, it } from 'vitest';
import type {
  LiveCommand
} from '@millionsnest/nestlive-production-domain';
import {
  ArtNetDmxControlClient,
  encodeArtDmx,
  encodeOscMessage
} from '../src/clients';
import { PRODUCTION_ADAPTER_MANIFESTS } from '../src/manifests';
import { ProductionControlAdapter } from '../src/ProductionControlAdapter';

function command(
  capability: LiveCommand['capability'],
  payload: Record<string, unknown>
): LiveCommand {
  return {
    id: 'cmd-1',
    correlationId: 'corr-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    liveSystemId: 'system-1',
    liveSessionId: 'session-1',
    actorId: 'operator-1',
    origin: 'live-ui',
    capability,
    targetProviderIds: [],
    outputTargets: ['main'],
    payload,
    idempotencyKey: 'idem-1',
    createdAt: '2026-09-26T12:00:00.000Z',
    safetyLevel: 'guarded'
  };
}

describe('production protocol encoders', () => {
  it('encodes an OSC address and type tag block on four-byte boundaries', () => {
    const packet = encodeOscMessage('/lights/look', [1, 0.5, true, 'altar']);
    expect(packet.subarray(0, 16).toString('utf8')).toContain('/lights/look');
    expect(packet.length % 4).toBe(0);
    expect(packet.toString('utf8')).toContain(',ifTs');
  });

  it('encodes an ArtDmx packet with the official header and bounded channel values', () => {
    const packet = encodeArtDmx({
      universe: 7,
      sequence: 12,
      channels: [0, 255, 300, -2]
    });
    expect(packet.subarray(0, 8).toString('ascii')).toBe('Art-Net\0');
    expect(packet.readUInt16LE(8)).toBe(0x5000);
    expect(packet.readUInt16BE(10)).toBe(14);
    expect(packet.readUInt16LE(14)).toBe(7);
    expect([...packet.subarray(18, 22)]).toEqual([0, 255, 255, 0]);
  });

  it('keeps every production integration behind the same adapter manifest contract', () => {
    expect(Object.values(PRODUCTION_ADAPTER_MANIFESTS).map(item => item.adapterKey))
      .toEqual([
        'obs-websocket',
        'companion',
        'osc',
        'midi',
        'atem',
        'vmix',
        'artnet-dmx'
      ]);
    for (const manifest of Object.values(PRODUCTION_ADAPTER_MANIFESTS)) {
      expect(manifest.requiresLocalNode).toBe(true);
      expect(manifest.secretsStayLocal).toBe(true);
    }
  });
});

describe('ProductionControlAdapter', () => {
  it('translates a vMix preview through the provider contract', async () => {
    const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const adapter = new ProductionControlAdapter({
      id: 'vmix-main',
      nodeId: 'node-a',
      manifest: PRODUCTION_ADAPTER_MANIFESTS.vmix,
      client: {
        async probe() {
          return { reachable: true, version: '29' };
        },
        async invoke(action, payload) {
          calls.push({ action, payload });
          return { accepted: true, observed: { preview: payload.Input } };
        }
      }
    });

    expect((await adapter.probe()).reachable).toBe(true);
    const result = await adapter.execute(command(
      'presentation.preview',
      { input: 'Camera 2' }
    ));
    expect(result.accepted).toBe(true);
    expect(calls).toEqual([
      { action: 'PreviewInput', payload: { Input: 'Camera 2' } }
    ]);
  });

  it('requires an explicit safe blank scene for OBS clear', async () => {
    const adapter = new ProductionControlAdapter({
      id: 'obs-main',
      nodeId: 'node-a',
      manifest: PRODUCTION_ADAPTER_MANIFESTS.obs,
      client: {
        async probe() {
          return { reachable: true };
        },
        async invoke() {
          return { accepted: true };
        }
      }
    });

    const result = await adapter.execute(command('presentation.clear', {}));
    expect(result.accepted).toBe(false);
    expect(result.errorCode).toBe('obs_blank_scene_required');
  });

  it('rejects empty Art-Net channel writes before any UDP send', async () => {
    const client = new ArtNetDmxControlClient('127.0.0.1');
    const result = await client.invoke('dmx', { channels: [] });
    expect(result).toEqual({
      accepted: false,
      errorCode: 'artnet_channels_required',
      recoverable: false
    });
  });
});
