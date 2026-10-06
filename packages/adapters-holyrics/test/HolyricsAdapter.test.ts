import { describe, expect, it } from 'vitest';
import type { LiveCommand } from '@millionsnest/nestlive-production-domain';
import { HolyricsAdapter } from '../src/HolyricsAdapter';
import type { HolyricsApi, HolyricsSongDraft } from '../src/HolyricsHttpClient';

class FakeApi implements HolyricsApi {
  calls: Array<{ action: string; input: Record<string, unknown> }> = [];

  canCreateSongDraft(): boolean {
    return true;
  }

  async createSongDraft(input: HolyricsSongDraft): Promise<{ opened: true }> {
    this.calls.push({
      action: 'popup-createsong',
      input: input as unknown as Record<string, unknown>
    });
    return { opened: true };
  }

  async request<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ action, input });
    if (action === 'GetTokenInfo') {
      return {
        version: '2.30.0',
        permissions: [
          'GetCurrentPresentation',
          'ActionNext',
          'ActionPrevious',
          'ActionGoToIndex',
          'CloseCurrentPresentation',
          'SetF8',
          'SetF9',
          'SetF10',
          'GetCurrentBackground',
          'GetBackgrounds',
          'GetThumbnail',
          'SetCurrentBackground',
          'IdentifyVerseReferences',
          'GetBibleVersionsV2',
          'GetBibleBooks',
          'ShowVerse',
          'SearchText',
          'ShowText',
          'ShowQuickPresentation',
          'GetAnnouncements',
          'ShowAnnouncement',
          'SearchLyrics',
          'ShowLyrics',
          'AddLyricsToPlaylist',
          'GetLyricsPlaylist',
          'RemoveFromLyricsPlaylist',
          'GetAudios',
          'GetVideos',
          'GetImages',
          'PlayAudio',
          'PlayVideo',
          'ShowImage',
          'SetTextCommunicationPanel'
        ].join(',')
      } as T;
    }
    if (action === 'GetCurrentPresentation') {
      return { id: 'p1', type: 'song', slide_number: 2, total_slides: 5 } as T;
    }
    if (action === 'GetBibleVersionsV2') {
      return [
        { key: 'pt_nvi', version: 'pt_nvi', title: 'NVI', language: { id: 'pt', iso: 'pt', name: 'Portuguese' } },
        { key: 'pt_acf', version: 'pt_acf', title: 'ACF', language: { id: 'pt', iso: 'pt', name: 'Portuguese' } }
      ] as T;
    }
    if (action === 'GetBibleBooks') {
      return [
        { id: '43', name: 'João', abbrev: 'Jo', usfx_code: 'JHN' },
        { id: '44', name: 'Atos', abbrev: 'At', usfx_code: 'ACT' }
      ] as T;
    }
    if (action === 'SearchText') {
      return [{
        id: 'text-1',
        title: 'Boas-vindas',
        folder: 'Culto',
        slides: [{ text: 'Sejam bem-vindos' }]
      }] as T;
    }
    if (action === 'GetAnnouncements') {
      return [
        { id: 'ann-1', name: 'Contribuição', text: 'Informações de contribuição', archived: false }
      ] as T;
    }
    if (action === 'IdentifyVerseReferences') {
      return [{
        reference: 'João 3:1-3',
        ids: ['43003001', '43003002', '43003003'],
        verses: [
          { id: '43003001', book: 43, chapter: 3, verse: 1, reference: 'João 3:1' },
          { id: '43003002', book: 43, chapter: 3, verse: 2, reference: 'João 3:2' },
          { id: '43003003', book: 43, chapter: 3, verse: 3, reference: 'João 3:3' }
        ]
      }] as T;
    }
    if (action === 'GetCurrentBackground') {
      return { id: 'bg-1', type: 'my_image', name: 'Blue Waves' } as T;
    }
    if (action === 'GetBackgrounds') {
      return [
        { id: 'bg-1', type: 'my_image', name: 'Blue Waves' },
        { id: 'bg-2', type: 'my_video', name: 'Soft Motion' }
      ] as T;
    }
    if (action === 'GetThumbnail') {
      return [
        { id: 'bg-1', type: 'background', image: 'base64-one' },
        { id: 'bg-2', type: 'background', image: 'base64-two' }
      ] as T;
    }
    return undefined as T;
  }
}

function command(capability: LiveCommand['capability'], payload: Record<string, unknown>): LiveCommand {
  return {
    id: 'cmd-1',
    correlationId: 'corr-1',
    organizationId: 'org-1',
    venueId: 'venue-1',
    liveSystemId: 'system-1',
    liveSessionId: 'session-1',
    actorId: 'user-1',
    origin: 'live-ui',
    capability,
    targetProviderIds: ['holyrics-1'],
    outputTargets: ['main'],
    payload,
    idempotencyKey: 'idem-1',
    createdAt: new Date(0).toISOString(),
    safetyLevel: 'normal'
  };
}

describe('HolyricsAdapter', () => {
  it('derives capabilities from token permissions', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    const probe = await adapter.probe();

    expect(probe.reachable).toBe(true);
    expect(probe.capabilities).toContain('presentation.navigation');
    expect(probe.capabilities).toContain('presentation.screen.mode');
    expect(probe.capabilities).toContain('presentation.background.read');
    expect(probe.capabilities).toContain('presentation.background.set');
    expect(probe.capabilities).toContain('bible.search');
    expect(probe.capabilities).toContain('bible.versions.read');
    expect(probe.capabilities).toContain('bible.books.read');
    expect(probe.capabilities).toContain('bible.present');
    expect(probe.capabilities).toContain('text.search');
    expect(probe.capabilities).toContain('text.present');
    expect(probe.capabilities).toContain('text.quick.present');
    expect(probe.capabilities).toContain('announcement.read');
    expect(probe.capabilities).toContain('announcement.present');
    expect(probe.capabilities).toContain('songs.create');
    expect(probe.capabilities).toContain('songs.present');
    expect(probe.capabilities).toContain('playlist.write');
    expect(probe.capabilities).toContain('playlist.sync');
    expect(probe.capabilities).toContain('media.search');
    expect(probe.capabilities).toContain('media.open');
  });

  it('maps neutral black screen mode without exposing Holyrics F-keys to the domain', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('presentation.screen.mode', { mode: 'black' }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'SetF10' && call.input.enable === true)).toBe(true);
    expect(api.calls.some(call => call.action === 'SetF8' && call.input.enable === false)).toBe(true);
    expect(api.calls.some(call => call.action === 'SetF9' && call.input.enable === false)).toBe(true);
  });

  it('reads the Holyrics background library with thumbnails without changing Program', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('presentation.background.read', {}));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'GetBackgrounds')).toBe(true);
    expect(api.calls.some(call => call.action === 'GetThumbnail')).toBe(true);
    const backgrounds = result.observedState?.backgrounds as Array<Record<string, unknown>>;
    expect(backgrounds[0]?.thumbnail).toBe('base64-one');
    expect(api.calls.some(call => call.action === 'SetCurrentBackground')).toBe(false);
  });

  it('changes the Holyrics background only after an explicit set command', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('presentation.background.set', {
      id: 'bg-2',
      type: 'my_video'
    }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'SetCurrentBackground' &&
      call.input.id === 'bg-2'
    )).toBe(true);
  });

  it('maps neutral next navigation to the documented Holyrics ActionNext action', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();
    const result = await adapter.execute(command('presentation.navigation', { action: 'next' }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'ActionNext')).toBe(true);
  });

  it('synchronizes the current playlist idempotently', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const originalRequest = api.request.bind(api);
    api.request = async <T,>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
      if (action === 'GetLyricsPlaylist') {
        api.calls.push({ action, input });
        return [{ id: 'old-1' }, { id: 'old-2' }] as T;
      }
      return originalRequest<T>(action, input);
    };

    const result = await adapter.execute(command('playlist.sync', { ids: ['new-1', 'new-2'] }));
    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'RemoveFromLyricsPlaylist')).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'AddLyricsToPlaylist' &&
      Array.isArray(call.input.ids) &&
      call.input.ids[0] === 'new-1'
    )).toBe(true);
  });

  it('opens the official Holyrics create-song flow with MusicScale content', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('songs.create', {
      title: 'Promessas',
      artist: 'Sarah Beatriz',
      lyrics: 'Deus de Abraão',
      key: 'G#m',
      bpm: 72
    }));

    expect(result.accepted).toBe(true);
    expect(result.observedState?.requiresProviderSave).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'popup-createsong' &&
      call.input.title === 'Promessas' &&
      call.input.lyrics === 'Deus de Abraão'
    )).toBe(true);
  });

  it('searches and presents saved text through documented Holyrics actions', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const search = await adapter.execute(command('text.search', { text: 'boas' }));
    expect(search.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'SearchText' &&
      call.input.text === 'boas'
    )).toBe(true);
    expect(search.observedState?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'text-1', title: 'Boas-vindas' })
    ]));

    const present = await adapter.execute(command('text.present', {
      id: 'text-1',
      initialIndex: 1
    }));
    expect(present.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'ShowText' &&
      call.input.id === 'text-1' &&
      call.input.initial_index === 1
    )).toBe(true);
  });

  it('shows quick text without inventing a saved provider item', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('text.quick.present', {
      text: 'Culto começa em 5 minutos'
    }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'ShowQuickPresentation' &&
      call.input.text === 'Culto começa em 5 minutos'
    )).toBe(true);
  });

  it('reads and presents announcements through documented Holyrics actions', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const read = await adapter.execute(command('announcement.read', {}));
    expect(read.accepted).toBe(true);
    expect(read.observedState?.announcements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ann-1', name: 'Contribuição' })
    ]));

    const present = await adapter.execute(command('announcement.present', { id: 'ann-1' }));
    expect(present.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'ShowAnnouncement' &&
      call.input.id === 'ann-1'
    )).toBe(true);
  });

  it('maps song presentation to ShowLyrics', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();
    const result = await adapter.execute(command('songs.present', { id: 'song-44' }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'ShowLyrics' && call.input.id === 'song-44')).toBe(true);
  });

  it('maps neutral media open to the correct Holyrics media action', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('media.open', {
      kind: 'video',
      file: 'backgrounds/intro.mp4'
    }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'PlayVideo' &&
      call.input.file === 'backgrounds/intro.mp4'
    )).toBe(true);
  });

  it('asks Holyrics for the whole chapter and preserves provider verse IDs for navigation', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('bible.search', {
      text: 'João 3',
      languageId: 'pt'
    }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'IdentifyVerseReferences' &&
      call.input.value === 'João 3' &&
      call.input.language_id === 'pt'
    )).toBe(true);
    expect(result.observedState?.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ids: ['43003001', '43003002', '43003003']
      })
    ]));
  });

  it('reads the provider book list for a concrete Bible language', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('bible.books.read', { languageId: 'pt' }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call =>
      call.action === 'GetBibleBooks' &&
      call.input.language_id === 'pt'
    )).toBe(true);
    expect(result.observedState?.books).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '43', name: 'João', abbrev: 'Jo' })
    ]));
  });

  it('reads Bible versions through the documented Holyrics version endpoint', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();

    const result = await adapter.execute(command('bible.versions.read', {}));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'GetBibleVersionsV2')).toBe(true);
    expect(result.observedState?.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 'pt_nvi', title: 'NVI' })
    ]));
  });

  it('maps Bible presentation to ShowVerse and refreshes the observed Program state', async () => {
    const api = new FakeApi();
    const adapter = new HolyricsAdapter({ id: 'holyrics-1', nodeId: 'node-1', api });
    await adapter.probe();
    const result = await adapter.execute(command('bible.present', { references: 'Jo 3:16' }));

    expect(result.accepted).toBe(true);
    expect(api.calls.some(call => call.action === 'ShowVerse')).toBe(true);
    expect(result.observedState?.currentPresentation).toEqual(expect.objectContaining({
      id: 'p1'
    }));
  });
});
