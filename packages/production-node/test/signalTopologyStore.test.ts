import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SignalTopologyStore,
  validateSignalTopology
} from '../src/signalTopologyStore';

describe('SignalTopologyStore', () => {
  it('persists a neutral Holyrics to Arena to LED path without carrying video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mn-live-signal-'));
    const store = new SignalTopologyStore(join(dir, 'signal-topology.json'));

    const saved = await store.replace({
      endpoints: [
        {
          id: 'holyrics-program',
          name: 'Holyrics Program',
          role: 'source',
          kind: 'provider',
          nodeId: 'node_projection',
          providerId: 'holyrics-primary',
          enabled: true
        },
        {
          id: 'arena-input',
          name: 'Arena Presentation Input',
          role: 'input',
          kind: 'ndi',
          nodeId: 'node_led',
          providerId: 'resolume-primary',
          enabled: true
        },
        {
          id: 'main-led',
          name: 'LED Principal',
          role: 'output',
          kind: 'led',
          nodeId: 'node_led',
          enabled: true
        }
      ],
      links: [
        {
          id: 'holyrics-to-arena',
          fromEndpointId: 'holyrics-program',
          toEndpointId: 'arena-input',
          transport: 'ndi',
          enabled: true
        },
        {
          id: 'arena-to-led',
          fromEndpointId: 'arena-input',
          toEndpointId: 'main-led',
          transport: 'internal',
          enabled: true
        }
      ]
    });

    expect(saved.revision).toBe(1);
    expect(saved.endpoints).toHaveLength(3);
    expect(saved.links).toHaveLength(2);

    const restored = new SignalTopologyStore(join(dir, 'signal-topology.json'));
    expect((await restored.load()).links[0]?.transport).toBe('ndi');
  });

  it('rejects broken links and backwards signal direction', () => {
    expect(() => validateSignalTopology({
      endpoints: [{
        id: 'screen',
        name: 'Main Screen',
        role: 'output',
        kind: 'display',
        enabled: true
      }],
      links: [{
        id: 'broken',
        fromEndpointId: 'screen',
        toEndpointId: 'missing',
        transport: 'internal',
        enabled: true
      }]
    })).toThrow();

    expect(() => validateSignalTopology({
      endpoints: [
        { id: 'out', name: 'Out', role: 'output', kind: 'display', enabled: true },
        { id: 'src', name: 'Src', role: 'source', kind: 'provider', enabled: true }
      ],
      links: [{
        id: 'reverse',
        fromEndpointId: 'out',
        toEndpointId: 'src',
        transport: 'internal',
        enabled: true
      }]
    })).toThrow('invalid_signal_direction');
  });
});
