import { describe, expect, it } from 'vitest';
import { matchExternalSong, normalizeSongIdentity } from '../src/songMatching';

describe('song matching', () => {
  it('normalizes accents, punctuation and featured-artist suffixes', () => {
    expect(normalizeSongIdentity('Promessas (part. Samuel Messias)')).toBe('promessas');
    expect(normalizeSongIdentity('Águas — Vivas!')).toBe('aguas vivas');
  });

  it('auto-matches only one strict title-and-artist result', () => {
    const result = matchExternalSong(
      { title: 'Promessas', artist: 'Sarah Beatriz' },
      [
        { id: 'h1', title: 'Promessas', artist: 'Sarah Beatriz' },
        { id: 'h2', title: 'Promessas', artist: 'Outro Artista' }
      ]
    );
    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.candidate.id).toBe('h1');
  });

  it('refuses to auto-pick duplicated exact candidates', () => {
    const result = matchExternalSong(
      { title: 'Santo', artist: 'Banda A' },
      [
        { id: 'h1', title: 'Santo', artist: 'Banda A' },
        { id: 'h2', title: 'Santo', artist: 'Banda A' }
      ]
    );
    expect(result.status).toBe('ambiguous');
  });

  it('uses lyrics fingerprint and version to disambiguate same-title arrangements', () => {
    const result = matchExternalSong(
      {
        title: 'Santo',
        artist: 'Banda A',
        version: 'Acústico',
        lyricsFingerprint: 'verse-chorus-v2'
      },
      [
        {
          id: 'h-live',
          title: 'Santo',
          artist: 'Banda A',
          version: 'Ao Vivo',
          lyricsFingerprint: 'other-lyrics'
        },
        {
          id: 'h-acoustic',
          title: 'Santo',
          artist: 'Banda A',
          version: 'Acústico',
          lyricsFingerprint: 'verse-chorus-v2'
        }
      ]
    );

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.candidate.id).toBe('h-acoustic');
      expect(result.candidate.confidence).toBe('high');
      expect(result.candidate.reasons).toContain('lyrics_fingerprint_exact');
    }
  });

  it('keeps fuzzy title matches reviewable instead of guessing', () => {
    const result = matchExternalSong(
      { title: 'Tu És Fiel Senhor', artist: 'Equipe' },
      [
        { id: 'h1', title: 'Tu Es Fiel', artist: 'Equipe' },
        { id: 'h2', title: 'Tu És Fiel Senhor - Live', artist: 'Equipe' }
      ]
    );

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates[0]!.score).toBeGreaterThan(58);
      expect(result.candidates[0]!.reasons.length).toBeGreaterThan(0);
    }
  });

  it('marks unrelated results as missing', () => {
    const result = matchExternalSong(
      { title: 'Canção Inexistente', artist: 'Artista X' },
      [{ id: 'h1', title: 'Outra Música', artist: 'Artista Y' }]
    );
    expect(result.status).toBe('missing');
  });
});
