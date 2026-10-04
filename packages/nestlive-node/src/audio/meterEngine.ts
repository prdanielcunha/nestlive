import type {
  MeterFrame,
  MeterValue
} from '@millionsnest/nestlive-domain';

export type MeterVisualState =
  | 'silent'
  | 'low'
  | 'healthy'
  | 'strong'
  | 'near_clip'
  | 'clip'
  | 'stale';

export interface RenderedMeterValue {
  id: string;
  rawDb: number;
  displayDb: number;
  peakHoldDb: number;
  clip: boolean;
  stale: boolean;
  state: MeterVisualState;
}

export interface RenderedMeterSnapshot {
  providerInstanceId?: string;
  sequence?: number;
  capturedAt?: number;
  stale: boolean;
  channels: RenderedMeterValue[];
  buses: RenderedMeterValue[];
  mains: RenderedMeterValue[];
}

interface TrackState {
  rawDb: number;
  displayDb: number;
  peakHoldDb: number;
  peakAnchorAt: number;
  lastSeenAt: number;
  clip: boolean;
}

export interface MeterEngineOptions {
  floorDb?: number;
  attack?: number;
  release?: number;
  peakHoldMs?: number;
  peakDecayDbPerSecond?: number;
  staleAfterMs?: number;
}

export class MeterEngine {
  private readonly floorDb: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly peakHoldMs: number;
  private readonly peakDecayDbPerSecond: number;
  private readonly staleAfterMs: number;

  private readonly tracks = new Map<string, TrackState>();
  private lastFrame?: MeterFrame;

  constructor(options: MeterEngineOptions = {}) {
    this.floorDb = options.floorDb ?? -96;
    this.attack = options.attack ?? 0.72;
    this.release = options.release ?? 0.18;
    this.peakHoldMs = options.peakHoldMs ?? 900;
    this.peakDecayDbPerSecond = options.peakDecayDbPerSecond ?? 18;
    this.staleAfterMs = options.staleAfterMs ?? 750;
  }

  ingest(
    frame: MeterFrame,
    now = frame.capturedAt
  ): RenderedMeterSnapshot {
    this.lastFrame = frame;

    const update = (
      prefix: string,
      values: MeterValue[] | undefined
    ): RenderedMeterValue[] =>
      (values ?? []).map(value =>
        this.updateValue(`${prefix}:${value.id}`, value, now)
      );

    return {
      providerInstanceId: frame.providerInstanceId,
      sequence: frame.sequence,
      capturedAt: frame.capturedAt,
      stale: false,
      channels: update('channel', frame.channels),
      buses: update('bus', frame.buses),
      mains: update('main', frame.mains)
    };
  }

  snapshot(now = Date.now()): RenderedMeterSnapshot {
    if (!this.lastFrame) {
      return {
        stale: true,
        channels: [],
        buses: [],
        mains: []
      };
    }

    const stale = now - this.lastFrame.capturedAt > this.staleAfterMs;

    const render = (
      prefix: string,
      values: MeterValue[] | undefined
    ): RenderedMeterValue[] =>
      (values ?? []).map(value =>
        this.renderExisting(`${prefix}:${value.id}`, value.id, now, stale)
      );

    return {
      providerInstanceId: this.lastFrame.providerInstanceId,
      sequence: this.lastFrame.sequence,
      capturedAt: this.lastFrame.capturedAt,
      stale,
      channels: render('channel', this.lastFrame.channels),
      buses: render('bus', this.lastFrame.buses),
      mains: render('main', this.lastFrame.mains)
    };
  }

  private resolveDb(value: MeterValue): number {
    return (
      value.peakDb ??
      value.postFaderDb ??
      value.rmsDb ??
      value.preFaderDb ??
      this.floorDb
    );
  }

  private updateValue(
    key: string,
    value: MeterValue,
    now: number
  ): RenderedMeterValue {
    const rawDb = Math.max(this.floorDb, this.resolveDb(value));
    const previous = this.tracks.get(key);
    const alpha =
      !previous || rawDb >= previous.displayDb
        ? this.attack
        : this.release;

    const displayDb = previous
      ? previous.displayDb + (rawDb - previous.displayDb) * alpha
      : rawDb;

    let peakHoldDb = rawDb;
    let peakAnchorAt = now;

    if (previous && rawDb < previous.peakHoldDb) {
      const sincePeak = Math.max(0, now - previous.peakAnchorAt);

      if (sincePeak <= this.peakHoldMs) {
        peakHoldDb = previous.peakHoldDb;
        peakAnchorAt = previous.peakAnchorAt;
      } else {
        const elapsedSeconds = Math.max(
          0,
          (now - previous.lastSeenAt) / 1000
        );
        peakHoldDb = Math.max(
          rawDb,
          previous.peakHoldDb -
            this.peakDecayDbPerSecond * elapsedSeconds
        );
        peakAnchorAt = previous.peakAnchorAt;
      }
    }

    const clip = Boolean(value.clip) || rawDb >= 0;

    this.tracks.set(key, {
      rawDb,
      displayDb,
      peakHoldDb,
      peakAnchorAt,
      lastSeenAt: now,
      clip
    });

    return {
      id: value.id,
      rawDb,
      displayDb,
      peakHoldDb,
      clip,
      stale: false,
      state: classifyMeter(rawDb, clip, false)
    };
  }

  private renderExisting(
    key: string,
    id: string,
    now: number,
    frameStale: boolean
  ): RenderedMeterValue {
    const track = this.tracks.get(key);

    if (!track) {
      return {
        id,
        rawDb: this.floorDb,
        displayDb: this.floorDb,
        peakHoldDb: this.floorDb,
        clip: false,
        stale: frameStale,
        state: frameStale ? 'stale' : 'silent'
      };
    }

    const stale =
      frameStale || now - track.lastSeenAt > this.staleAfterMs;

    return {
      id,
      rawDb: track.rawDb,
      displayDb: track.displayDb,
      peakHoldDb: track.peakHoldDb,
      clip: track.clip,
      stale,
      state: classifyMeter(track.displayDb, track.clip, stale)
    };
  }
}

export function classifyMeter(
  db: number,
  clip: boolean,
  stale: boolean
): MeterVisualState {
  if (stale) return 'stale';
  if (clip || db >= 0) return 'clip';
  if (db >= -3) return 'near_clip';
  if (db >= -9) return 'strong';
  if (db >= -24) return 'healthy';
  if (db >= -50) return 'low';
  return 'silent';
}
