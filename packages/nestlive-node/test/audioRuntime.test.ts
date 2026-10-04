import { describe, expect, it } from 'vitest';
import { SimulatedAudioConsoleProvider } from '@millionsnest/nestlive-adapter-audio-sim';
import { NestLiveAudioRuntime } from '../src';

describe('NestLiveAudioRuntime', () => {
  it('rejects capabilities the provider does not expose', async () => {
    const runtime = new NestLiveAudioRuntime();
    runtime.register(new SimulatedAudioConsoleProvider('sim'));

    await expect(
      runtime.execute({
        id: 'cmd-1',
        actorId: 'user',
        providerInstanceId: 'sim',
        createdAt: new Date().toISOString(),
        command: {
          type: 'setPhantom',
          channelId: 'ch-01',
          value: true
        },
        confirmedSafetyLevel: 'critical'
      })
    ).rejects.toThrow('audio_capability_unavailable');
  });

  it('requires guarded confirmation for mute', async () => {
    const runtime = new NestLiveAudioRuntime();
    runtime.register(new SimulatedAudioConsoleProvider('sim'));

    await expect(
      runtime.execute({
        id: 'cmd-2',
        actorId: 'user',
        providerInstanceId: 'sim',
        createdAt: new Date().toISOString(),
        command: {
          type: 'setMute',
          channelId: 'ch-01',
          value: true
        }
      })
    ).rejects.toThrow('audio_confirmation_required:guarded');

    const execution = await runtime.execute({
      id: 'cmd-3',
      actorId: 'user',
      providerInstanceId: 'sim',
      createdAt: new Date().toISOString(),
      command: {
        type: 'setMute',
        channelId: 'ch-01',
        value: true
      },
      confirmedSafetyLevel: 'guarded'
    });

    expect(execution.result.accepted).toBe(true);
  });
});
