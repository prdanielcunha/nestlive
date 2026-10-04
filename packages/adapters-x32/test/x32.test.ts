import { describe, expect, it } from 'vitest';
import {
  X32AudioConsoleProvider,
  dbToX32Level,
  decodeOscMessage,
  decodeX32MeterBlob,
  encodeOscMessage,
  linearMeterToDb,
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
