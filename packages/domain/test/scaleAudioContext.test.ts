import { describe, expect, it } from 'vitest';
import {
  buildSoundcheckFromScale,
  resolveScaleChannels,
  type ScaleAudioContext
} from '../src';

describe('scale to audio context', () => {
  const context: ScaleAudioContext = {
    serviceId: 'svc-1',
    venueId: 'monte',
    title: 'Culto Profético',
    scheduledAt: '2026-10-04T19:00:00-03:00',
    participants: [
      {
        userId: 'u-1',
        displayName: 'João',
        roleName: 'Guitarra'
      },
      {
        userId: 'u-2',
        displayName: 'Maria',
        roleName: 'Vocal 1'
      }
    ],
    assignments: [
      {
        id: 'a-1',
        venueId: 'monte',
        roleName: 'Guitarra',
        channelId: 'ch-12',
        enabled: true
      },
      {
        id: 'a-2',
        venueId: 'monte',
        roleName: 'Vocal 1',
        channelId: 'ch-02',
        enabled: true
      }
    ]
  };

  it('resolves people to stable role-channel mappings', () => {
    const resolved = resolveScaleChannels(context);
    expect(resolved[0]).toMatchObject({
      channelId: 'ch-12',
      participant: { displayName: 'João' }
    });
  });

  it('prefers person-specific mappings before role fallback', () => {
    const specific: ScaleAudioContext = {
      ...context,
      assignments: [
        {
          id: 'generic-vocal',
          venueId: 'monte',
          roleName: 'Vocal 1',
          channelId: 'ch-02',
          enabled: true
        },
        {
          id: 'maria-vocal',
          venueId: 'monte',
          roleName: 'Vocal 1',
          participantUserId: 'u-2',
          channelId: 'ch-05',
          enabled: true
        }
      ]
    };

    expect(
      resolveScaleChannels(specific).find(
        item => item.participant?.userId === 'u-2'
      )?.channelId
    ).toBe('ch-05');
  });

  it('creates a soundcheck without generating console changes', () => {
    const session = buildSoundcheckFromScale(
      context,
      new Date('2026-10-04T18:00:00-03:00')
    );
    expect(session.channels[0]).toMatchObject({
      roleName: 'Guitarra',
      musicianName: 'João',
      state: 'pending'
    });
    expect(JSON.stringify(session)).not.toContain('gainDb');
    expect(JSON.stringify(session)).not.toContain('routing');
  });
});
