import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HiqnetCaptureHarness,
  type HiqnetFrameEvidence
} from './HiqnetCaptureHarness';

export interface SoundcraftSpikeMarker {
  id: string;
  capturedAt: string;
  action: string;
  expectedObservation?: string;
  note?: string;
  frameIndex: number;
}

export interface SoundcraftSpikeReport {
  schemaVersion: 1;
  sessionId: string;
  venue: string;
  consoleModel: string;
  firmware?: string;
  localAddress?: string;
  port: number;
  startedAt: string;
  stoppedAt: string;
  markers: SoundcraftSpikeMarker[];
  frames: HiqnetFrameEvidence[];
  capturedFrames: number;
  droppedFrames: number;
  writesPerformedByNestLive: 0;
}

export interface SoundcraftPhysicalSpikeOptions {
  venue?: string;
  consoleModel?: string;
  firmware?: string;
  localAddress?: string;
  port?: number;
  maxFrames?: number;
  captureFullPayload?: boolean;
}

/**
 * Read-only physical evidence recorder for the Soundcraft Si spike.
 *
 * NestLive never emits HiQnet commands from this class. The operator makes
 * one physical change at a time on the console and places a marker before/after
 * the action, allowing the captured traffic to be correlated later without
 * guessing protocol semantics.
 */
export class SoundcraftPhysicalSpikeSession {
  readonly sessionId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly markers: SoundcraftSpikeMarker[] = [];
  private readonly harness: HiqnetCaptureHarness;
  private stoppedAt?: string;

  constructor(
    private readonly options: SoundcraftPhysicalSpikeOptions = {}
  ) {
    this.harness = new HiqnetCaptureHarness({
      localAddress: options.localAddress,
      port: options.port,
      maxFrames: options.maxFrames,
      captureFullPayload: options.captureFullPayload ?? true
    });
  }

  async start(): Promise<void> {
    if (this.stoppedAt) throw new Error('soundcraft_spike_already_stopped');
    await this.harness.start();
  }

  mark(input: {
    action: string;
    expectedObservation?: string;
    note?: string;
  }): SoundcraftSpikeMarker {
    if (this.stoppedAt) throw new Error('soundcraft_spike_already_stopped');
    const action = input.action.trim();
    if (!action) throw new Error('soundcraft_spike_action_required');

    const marker: SoundcraftSpikeMarker = {
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
      action,
      expectedObservation: input.expectedObservation?.trim() || undefined,
      note: input.note?.trim() || undefined,
      frameIndex: this.harness.snapshot().length
    };
    this.markers.push(marker);
    return { ...marker };
  }

  snapshot(): Omit<SoundcraftSpikeReport, 'stoppedAt'> & {
    stoppedAt?: string;
  } {
    const stats = this.harness.stats();
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      venue: this.options.venue ?? 'Industrial',
      consoleModel:
        this.options.consoleModel ?? 'Soundcraft Si Expression',
      firmware: this.options.firmware,
      localAddress: this.options.localAddress,
      port: stats.port,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      markers: this.markers.map(marker => ({ ...marker })),
      frames: this.harness.snapshot(),
      capturedFrames: stats.capturedFrames,
      droppedFrames: stats.droppedFrames,
      writesPerformedByNestLive: 0
    };
  }

  async stop(): Promise<SoundcraftSpikeReport> {
    if (!this.stoppedAt) {
      await this.harness.stop();
      this.stoppedAt = new Date().toISOString();
    }
    return this.snapshot() as SoundcraftSpikeReport;
  }

  async saveReport(filePath: string): Promise<SoundcraftSpikeReport> {
    const report = this.stoppedAt
      ? (this.snapshot() as SoundcraftSpikeReport)
      : await this.stop();

    await mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await writeFile(temp, JSON.stringify(report, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temp, filePath);
    return report;
  }
}
