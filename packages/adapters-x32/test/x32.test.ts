import { describe, expect, it } from 'vitest';
import {
  X32AudioConsoleProvider,
  dbToX32Level,
  decodeOscMessage,
  decodeX32MeterBlob,
  encodeOscMessage,
  headampGainToNormalized,
  linearMeterToDb,
  normalizedToHeadampGain,
  normalizedToQ,
  qToNormalized,
  resolveX32HeadampIndex,
  x32LevelToDb,
  type OscArgument,
  type OscMessage,
  type X32Transport
} from '../src';

class FakeTransport implements X32Transport {
  sent: Array<{ address: string; args: OscArgument[] }> = [];
  values = new Map<string, OscMessage>();

  async send(address: string, args: OscArgument[] = []): Promise<void> {
    this.sent.push({ address, args });
    const first = args[0];
    if (
      first &&
      (first.type === 'f' || first.type === 'i') &&
      address !== '/meters'
    ) {
      this.values.set(address, {
        address,
        args: [first]
      });
      if (address === '/-snap/load' && first.type === 'i') {
        this.values.set('/-show/prepos/current', {
          address: '/-show/prepos/current',
          args: [{ type: 'i', value: first.value }]
        });
      }
    }
  }

  async request(address: string): Promise<OscMessage> {
    const existing = this.values.get(address);
    if (existing) return existing;
    if (address === '/xinfo') {
      return {
        address,
        args: [
          { type: 's', value: '192.168.32.2' },
          { type: 's', value: 'X32' },
          { type: 's', value: 'X32' },
          { type: 's', value: '4.x' }
        ]
      };
    }
    return { address, args: [{ type: 'f', value: 0.75 }] };
  }

  async *messages(): AsyncIterable<OscMessage> {
    return;
  }

  async close(): Promise<void> {}
}

describe('X32 OSC foundation', () => {
  it('round-trips OSC messages', () => {
    const encoded = encodeOscMessage('/ch/01/mix/fader', [
      { type: 'f', value: 0.75 }
    ]);
    const decoded = decodeOscMessage(encoded);

    expect(decoded.address).toBe('/ch/01/mix/fader');
    expect(decoded.args[0]?.type).toBe('f');
    expect(
      (decoded.args[0] as { type: 'f'; value: number }).value
    ).toBeCloseTo(0.75);
  });

  it('decodes X32 little-endian meter blobs', () => {
    const bytes = new Uint8Array(4 + 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 2, true);
    view.setFloat32(4, 1, true);
    view.setFloat32(8, 0.5, true);

    expect(decodeX32MeterBlob(bytes)).toEqual([1, 0.5]);
  });

  it('converts fader levels in both directions', () => {
    expect(dbToX32Level(-90)).toBe(0);
    expect(x32LevelToDb(0)).toBeLessThanOrEqual(-90);
    for (const db of [-60, -30, -10, 0, 10]) {
      expect(x32LevelToDb(dbToX32Level(db))).toBeCloseTo(db, 4);
    }
  });

  it('maps physical headamps and processing values without guessed units', () => {
    expect(resolveX32HeadampIndex(1)).toBe(0);
    expect(resolveX32HeadampIndex(32)).toBe(31);
    expect(resolveX32HeadampIndex(33)).toBe(32);
    expect(resolveX32HeadampIndex(80)).toBe(79);
    expect(resolveX32HeadampIndex(81)).toBe(80);
    expect(resolveX32HeadampIndex(128)).toBe(127);
    expect(resolveX32HeadampIndex(129)).toBeUndefined();

    for (const db of [-12, 0, 24, 60]) {
      expect(
        normalizedToHeadampGain(headampGainToNormalized(db))
      ).toBeCloseTo(db, 5);
    }

    for (const q of [0.3, 1, 3, 10]) {
      expect(normalizedToQ(qToNormalized(q))).toBeCloseTo(q, 5);
    }
  });

  it('uses linear full-scale meter conversion', () => {
    expect(linearMeterToDb(1)).toBeCloseTo(0);
    expect(linearMeterToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it('exposes only implemented deep capabilities', () => {
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-monte',
      targetAddress: '192.168.32.2',
      transport: new FakeTransport()
    });

    expect(provider.capabilities().has('audio.routing.read')).toBe(true);
    expect(provider.capabilities().has('audio.busSend.write')).toBe(true);
    expect(provider.capabilities().has('audio.phantom.write')).toBe(false);
    expect(provider.capabilities().has('audio.gain.write')).toBe(false);

    const certifiedLabProvider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-lab',
      targetAddress: '192.168.32.2',
      transport: new FakeTransport(),
      enableDeepControls: true
    });
    expect(certifiedLabProvider.capabilities().has('audio.gain.write')).toBe(true);
    expect(certifiedLabProvider.capabilities().has('audio.phantom.write')).toBe(true);
    expect(certifiedLabProvider.capabilities().has('audio.eq.write')).toBe(true);
    expect(certifiedLabProvider.capabilities().has('audio.scene.recall')).toBe(true);
  });

  it('reads Main LR assignment without inventing deeper routing', async () => {
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-monte',
      targetAddress: '192.168.32.2',
      transport: new FakeTransport()
    });

    const routing = await provider.getRouting();
    expect(routing.assignments).toHaveLength(32);
    expect(routing.assignments[0]).toEqual({
      sourceId: 'ch-01',
      targetId: 'main-lr',
      enabled: true
    });
  });

  it('writes a bus send through the documented channel send address', async () => {
    const transport = new FakeTransport();
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-monte',
      targetAddress: '192.168.32.2',
      transport
    });

    const result = await provider.setBusSend('ch-01', 'bus-03', -10);

    expect(result.accepted).toBe(true);
    expect(result.observedState?.busId).toBe('bus-03');
    expect(
      transport.sent.some(
        item => item.address === '/ch/01/mix/03/level'
      )
    ).toBe(true);
  });

  it('resolves channel source before touching gain or phantom', async () => {
    const transport = new FakeTransport();
    transport.values.set('/ch/01/config/source', {
      address: '/ch/01/config/source',
      args: [{ type: 'i', value: 33 }]
    });
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-lab',
      targetAddress: '192.168.32.2',
      transport,
      enableDeepControls: true
    });

    const gain = await provider.setGain('ch-01', 24);
    expect(gain.observedState?.gainDb).toBeCloseTo(24, 4);
    expect(
      transport.sent.some(
        item => item.address === '/headamp/032/gain'
      )
    ).toBe(true);

    const phantom = await provider.setPhantom('ch-01', true);
    expect(phantom.observedState?.phantom).toBe(true);
    expect(
      transport.sent.some(
        item => item.address === '/headamp/032/phantom'
      )
    ).toBe(true);
  });

  it('refuses gain writes when the channel source has no physical headamp', async () => {
    const transport = new FakeTransport();
    transport.values.set('/ch/01/config/source', {
      address: '/ch/01/config/source',
      args: [{ type: 'i', value: 129 }]
    });
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-lab',
      targetAddress: '192.168.32.2',
      transport,
      enableDeepControls: true
    });

    await expect(provider.setGain('ch-01', 12)).rejects.toThrow(
      'x32_channel_source_has_no_controllable_headamp'
    );
  });

  it('writes deep processing with read-back and confirms scene recall', async () => {
    const transport = new FakeTransport();
    transport.values.set('/ch/01/config/source', {
      address: '/ch/01/config/source',
      args: [{ type: 'i', value: 1 }]
    });
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-lab',
      targetAddress: '192.168.32.2',
      transport,
      enableDeepControls: true
    });

    const eq = await provider.setEq('ch-01', {
      on: true,
      bands: [
        { index: 1, frequencyHz: 120, gainDb: 2.5, q: 1.2 }
      ]
    });
    expect(eq.accepted).toBe(true);
    expect(
      transport.sent.some(item => item.address === '/ch/01/eq/1/f')
    ).toBe(true);

    const gate = await provider.setGate('ch-01', {
      on: true,
      thresholdDb: -35,
      releaseMs: 250
    });
    expect(gate.accepted).toBe(true);

    const compressor = await provider.setCompressor('ch-01', {
      on: true,
      thresholdDb: -18,
      ratio: 4,
      makeupGainDb: 3
    });
    expect(compressor.accepted).toBe(true);

    const scene = await provider.loadScene('scene-7');
    expect(scene.accepted).toBe(true);
    expect(scene.observedState?.sceneIndex).toBe(6);
  });

  it('confirms observed fader state after writes', async () => {
    const transport = new FakeTransport();
    const provider = new X32AudioConsoleProvider({
      providerInstanceId: 'x32-monte',
      targetAddress: '192.168.32.2',
      transport
    });

    const result = await provider.setFader('ch-01', 0);

    expect(result.accepted).toBe(true);
    expect(result.observedState?.faderDb).toBeCloseTo(0, 4);
    expect(
      transport.sent.some(
        item => item.address === '/ch/01/mix/fader'
      )
    ).toBe(true);
  });
});
