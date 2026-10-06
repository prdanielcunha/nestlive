import path from 'node:path';
import {
  SoundcraftPhysicalSpikeSession,
  type SoundcraftSpikeMarker,
  type SoundcraftSpikeReport
} from '@millionsnest/nestlive-adapter-soundcraft-si';

export interface SoundcraftSpikeStatus {
  active: boolean;
  sessionId?: string;
  startedAt?: string;
  frames: number;
  markers: number;
  droppedFrames: number;
  reportPath?: string;
}

export class SoundcraftSpikeCoordinator {
  private session?: SoundcraftPhysicalSpikeSession;
  private lastReport?: {
    report: SoundcraftSpikeReport;
    path: string;
  };

  constructor(private readonly reportsDirectory: string) {}

  async start(input: {
    localAddress?: string;
    firmware?: string;
  } = {}): Promise<SoundcraftSpikeStatus> {
    if (this.session) throw new Error('soundcraft_spike_already_active');

    const session = new SoundcraftPhysicalSpikeSession({
      venue: 'Industrial',
      consoleModel: 'Soundcraft Si Expression',
      firmware: input.firmware,
      localAddress: input.localAddress,
      port: 3804,
      maxFrames: 200_000,
      captureFullPayload: true
    });

    await session.start();
    this.session = session;
    this.lastReport = undefined;
    return this.status();
  }

  mark(input: {
    action: string;
    expectedObservation?: string;
    note?: string;
  }): SoundcraftSpikeMarker {
    if (!this.session) throw new Error('soundcraft_spike_not_active');
    return this.session.mark(input);
  }

  async stop(): Promise<{
    status: SoundcraftSpikeStatus;
    report: SoundcraftSpikeReport;
  }> {
    const session = this.session;
    if (!session) throw new Error('soundcraft_spike_not_active');

    const reportPath = path.join(
      this.reportsDirectory,
      `soundcraft-industrial-${session.sessionId}.json`
    );
    const report = await session.saveReport(reportPath);
    this.session = undefined;
    this.lastReport = { report, path: reportPath };

    return {
      status: this.status(),
      report
    };
  }

  status(): SoundcraftSpikeStatus {
    if (this.session) {
      const snapshot = this.session.snapshot();
      return {
        active: true,
        sessionId: snapshot.sessionId,
        startedAt: snapshot.startedAt,
        frames: snapshot.capturedFrames,
        markers: snapshot.markers.length,
        droppedFrames: snapshot.droppedFrames
      };
    }

    if (this.lastReport) {
      return {
        active: false,
        sessionId: this.lastReport.report.sessionId,
        startedAt: this.lastReport.report.startedAt,
        frames: this.lastReport.report.capturedFrames,
        markers: this.lastReport.report.markers.length,
        droppedFrames: this.lastReport.report.droppedFrames,
        reportPath: this.lastReport.path
      };
    }

    return {
      active: false,
      frames: 0,
      markers: 0,
      droppedFrames: 0
    };
  }

  async dispose(): Promise<void> {
    if (!this.session) return;
    await this.session.stop().catch(() => undefined);
    this.session = undefined;
  }
}
