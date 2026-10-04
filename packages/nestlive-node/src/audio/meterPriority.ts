import type { MeterFrame } from '@millionsnest/nestlive-domain';

export interface MeterBackpressureState {
  received: number;
  published: number;
  dropped: number;
  latestSequence?: number;
}

export class LatestMeterFrameBuffer {
  private latest?: MeterFrame;
  private state: MeterBackpressureState = {
    received: 0,
    published: 0,
    dropped: 0
  };

  push(frame: MeterFrame): void {
    this.state.received += 1;
    if (this.latest) this.state.dropped += 1;
    this.latest = frame;
    this.state.latestSequence = frame.sequence;
  }

  takeLatest(): MeterFrame | undefined {
    const frame = this.latest;
    this.latest = undefined;
    if (frame) this.state.published += 1;
    return frame;
  }

  stats(): MeterBackpressureState {
    return { ...this.state };
  }
}
