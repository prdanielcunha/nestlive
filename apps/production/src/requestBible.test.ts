import { describe, expect, it } from 'vitest';
import { bibleRequestFromResults } from './requestBible';

describe('provider-backed Bible request normalization', () => {
  it('preserves canonical reference, verse ids and provider identity', () => {
    const value = bibleRequestFromResults([
      {
        commandId: 'cmd-1',
        providerInstanceId: 'holyrics-primary',
        accepted: true,
        latencyMs: 12,
        observedState: {
          matches: [
            {
              reference: 'João 3:16-17',
              ids: ['43003016', '43003017'],
              verses: [{ verse: 16 }, { verse: 17 }]
            }
          ]
        }
      }
    ], 'Jo 3:16-17');

    expect(value).toEqual({
      reference: 'João 3:16-17',
      ids: ['43003016', '43003017'],
      verseCount: 2,
      providerId: 'holyrics-primary'
    });
  });

  it('ignores failed providers and never invents verse ids', () => {
    const value = bibleRequestFromResults([
      {
        commandId: 'cmd-2',
        providerInstanceId: 'holyrics-primary',
        accepted: false,
        latencyMs: 8,
        errorCode: 'provider_error'
      }
    ], 'João 3:16');

    expect(value).toEqual({
      reference: 'João 3:16',
      ids: [],
      verseCount: 0
    });
  });
});
