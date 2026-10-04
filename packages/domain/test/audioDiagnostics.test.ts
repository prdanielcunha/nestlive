import { describe, expect, it } from 'vitest';
import {
  buildSignalTrace,
  diagnoseAudio,
  markSoundcheckChannel,
  meterProfileTargetFps,
  recordSoundcheckPeak,
  selectRemoteMeterProfile,
  type SoundcheckSession
} from '../src';

describe('Audio Doctor', () => {
  it('finds a muted DCA-style failure deterministically', () => {
    const findings = diagnoseAudio({
      channelId: 'ch-01',
      channelName: 'Pastor',
      providerOnline: true,
      telemetryStale: false,
      inputDb: -18,
      postFaderDb: -8,
      outputDb: -96,
      faderDb: -3,
      muted: false,
      groupMuted: true,
      gateOpen: true,
      gainReductionDb: -2,
      assignedToMain: true
    });

    expect(
      findings.map(finding => finding.code)
    ).toContain('group_muted');
  });

  it('marks inference explicitly in signal failure reasoning', () => {
    const findings = diagnoseAudio({
      channelId: 'ch-01',
      channelName: 'Pastor',
      providerOnline: true,
      telemetryStale: false,
      inputDb: -18,
      postFaderDb: -8,
      outputDb: -96,
      faderDb: -3,
      muted: false,
      groupMuted: false,
      gateOpen: true,
      gainReductionDb: -2,
      assignedToMain: true
    });

    expect(
      findings.find(finding => finding.code === 'output_no_signal')?.evidence
    ).toBe('inferred');

    expect(buildSignalTrace({
      channelId: 'ch-01',
      channelName: 'Pastor',
      providerOnline: true,
      telemetryStale: false,
      inputDb: -18,
      outputDb: -96
    })).toHaveLength(6);
  });
});

describe('Soundcheck state', () => {
  it('keeps peak history and reopens attention after clipping', () => {
    const session: SoundcheckSession = {
      id: 'sc-1',
      title: 'Culto',
      startedAt: '2026-10-04T12:00:00Z',
      channels: [
        {
          channelId: 'ch-01',
          roleName: 'Pastor',
          state: 'pending',
          clipCount: 0
        }
      ]
    };

    const checked = markSoundcheckChannel(
      session,
      'ch-01',
      'checked',
      new Date('2026-10-04T12:05:00Z')
    );
    const clipped = recordSoundcheckPeak(checked, 'ch-01', 0.4);

    expect(clipped.channels[0]?.clipCount).toBe(1);
    expect(clipped.channels[0]?.state).toBe('attention');
  });
});

describe('Remote Mix adaptation', () => {
  it('reduces meter rate before disabling control', () => {
    const profile = selectRemoteMeterProfile({
      local: false,
      rttMs: 320,
      packetLossPercent: 2,
      visible: true
    });
    expect(profile).toBe('remote_medium');
    expect(meterProfileTargetFps(profile)).toBe(8);
    expect(
      selectRemoteMeterProfile({
        local: false,
        visible: false
      })
    ).toBe('off');
  });
});
