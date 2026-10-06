import type {
  Capability,
  CommandResult,
  LiveCommand,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderState
} from '@millionsnest/nestlive-production-domain';
import type { HolyricsApi } from './HolyricsHttpClient';

interface TokenInfo {
  version?: string;
  permissions?: string;
}

interface CurrentPresentation {
  id?: string;
  type?: string;
  name?: string;
  song_id?: string;
  slide_number?: number;
  total_slides?: number;
  slide_type?: string;
  slides?: unknown[];
  [key: string]: unknown;
}

interface HolyricsBackground {
  id?: string;
  type?: string;
  name?: string;
  tags?: string[];
  bpm?: number;
  [key: string]: unknown;
}

interface HolyricsThumbnail {
  id?: string;
  type?: string;
  image?: string;
}

const ACTIONS_BY_CAPABILITY: Partial<Record<Capability, string[]>> = {
  'presentation.slides.read': ['GetCurrentPresentation'],
  'presentation.navigation': ['ActionNext', 'ActionPrevious', 'ActionGoToIndex'],
  'presentation.preview': ['GetCurrentPresentation'],
  'presentation.clear': ['CloseCurrentPresentation'],
  'presentation.screen.mode': ['SetF8', 'SetF9', 'SetF10'],
  'presentation.background.read': ['GetCurrentBackground', 'GetBackgrounds', 'GetThumbnail'],
  'presentation.background.set': ['SetCurrentBackground', 'GetCurrentBackground'],
  'bible.search': ['IdentifyVerseReferences'],
  'bible.books.read': ['GetBibleBooks'],
  'bible.present': ['ShowVerse'],
  'text.search': ['SearchText'],
  'text.present': ['ShowText'],
  'text.quick.present': ['ShowQuickPresentation'],
  'announcement.read': ['GetAnnouncements'],
  'announcement.present': ['ShowAnnouncement'],
  'songs.search': ['SearchLyrics'],
  'songs.present': ['ShowLyrics'],
  'playlist.write': ['AddLyricsToPlaylist'],
  'playlist.sync': ['GetLyricsPlaylist', 'RemoveFromLyricsPlaylist', 'AddLyricsToPlaylist'],
  'media.search': ['GetAudios', 'GetVideos', 'GetImages'],
  'media.open': ['PlayAudio', 'PlayVideo', 'ShowImage'],
  'preview.snapshot': ['GetCurrentPresentation'],
  'stage.message': ['SetTextCommunicationPanel']
};

function permissionsToSet(value?: string): Set<string> {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function requiredActionsAllowed(
  granted: Set<string>,
  actions: string[]
): boolean {
  return actions.every(action => granted.has(action));
}

function versionAtLeast(value: string | undefined, minimum: [number, number, number]): boolean {
  const parts = String(value || '')
    .split(/[.-]/)
    .slice(0, 3)
    .map(part => Number.parseInt(part, 10));
  if (parts.some(part => !Number.isFinite(part))) return false;
  const [major = 0, minor = 0, patch = 0] = parts;
  const [minMajor, minMinor, minPatch] = minimum;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

export interface HolyricsAdapterOptions {
  id: string;
  nodeId: string;
  displayName?: string;
  api: HolyricsApi;
}

export class HolyricsAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly observationIntervalMs = 450;
  private readonly api: HolyricsApi;
  private readonly supported = new Set<Capability>();
  private grantedActions = new Set<string>();
  private lastState: ProviderState = {
    health: 'offline',
    updatedAt: new Date(0).toISOString(),
    observed: {}
  };

  constructor(options: HolyricsAdapterOptions) {
    this.api = options.api;
    this.descriptor = {
      id: options.id,
      nodeId: options.nodeId,
      kind: 'presentation',
      displayName: options.displayName || 'Holyrics',
      providerKey: 'holyrics'
    };
  }

  async probe() {
    try {
      const tokenInfo = await this.api.request<TokenInfo>('GetTokenInfo');
      const permissions = permissionsToSet(tokenInfo.permissions);
      this.grantedActions = permissions;
      this.supported.clear();

      for (const [capability, actions] of Object.entries(ACTIONS_BY_CAPABILITY) as Array<[Capability, string[]]>) {
        if (requiredActionsAllowed(permissions, actions)) {
          this.supported.add(capability);
        }
      }

      if (permissions.has('GetBibleVersionsV2') || permissions.has('GetBibleVersions')) {
        this.supported.add('bible.versions.read');
      }

      if (
        versionAtLeast(tokenInfo.version, [2, 21, 0]) &&
        this.api.canCreateSongDraft?.() === true &&
        typeof this.api.createSongDraft === 'function'
      ) {
        this.supported.add('songs.create');
      }

      this.descriptor.version = tokenInfo.version;
      this.lastState = {
        health: 'online',
        updatedAt: new Date().toISOString(),
        observed: {
          version: tokenInfo.version,
          permissionCount: permissions.size
        }
      };

      return {
        reachable: true,
        version: tokenInfo.version,
        capabilities: [...this.supported]
      };
    } catch (error) {
      this.supported.clear();
      this.grantedActions.clear();
      this.lastState = {
        health: 'offline',
        updatedAt: new Date().toISOString(),
        observed: {
          error: error instanceof Error ? error.message : 'holyrics_probe_failed'
        }
      };
      return {
        reachable: false,
        capabilities: [] as Capability[],
        reason: error instanceof Error ? error.message : 'holyrics_probe_failed'
      };
    }
  }

  capabilities(): ReadonlySet<Capability> {
    return this.supported;
  }

  peekState(): ProviderState {
    return {
      health: this.lastState.health,
      updatedAt: this.lastState.updatedAt,
      observed: { ...this.lastState.observed }
    };
  }

  async getState(): Promise<ProviderState> {
    if (!this.supported.has('presentation.slides.read')) {
      return this.lastState;
    }

    try {
      const presentation = await this.api.request<CurrentPresentation | null>(
        'GetCurrentPresentation'
      );
      this.lastState = {
        health: 'online',
        updatedAt: new Date().toISOString(),
        observed: {
          ...this.lastState.observed,
          currentPresentation: presentation
        }
      };
    } catch (error) {
      this.lastState = {
        health: 'degraded',
        updatedAt: new Date().toISOString(),
        observed: {
          ...this.lastState.observed,
          error: error instanceof Error ? error.message : 'holyrics_state_failed'
        }
      };
    }
    return this.lastState;
  }

  async execute(command: LiveCommand): Promise<CommandResult> {
    const started = performance.now();
    try {
      if (!this.supported.has(command.capability)) {
        return this.result(command, started, false, 'capability_not_supported', true);
      }

      const observedState = await this.executeCapability(command);
      return {
        commandId: command.id,
        providerInstanceId: this.descriptor.id,
        accepted: true,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        observedState
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'holyrics_command_failed';
      const recoverable =
        message.includes('timeout') ||
        message.includes('session') ||
        message.includes('http_');
      return this.result(
        command,
        started,
        false,
        recoverable ? 'provider_timeout' : 'provider_permission_denied',
        recoverable
      );
    }
  }

  private async executeCapability(
    command: LiveCommand
  ): Promise<Record<string, unknown> | undefined> {
    const payload = command.payload as Record<string, any>;

    switch (command.capability) {
      case 'presentation.slides.read':
      case 'presentation.preview':
      case 'preview.snapshot': {
        const currentPresentation = await this.api.request<CurrentPresentation | null>(
          'GetCurrentPresentation',
          {
            include_slides: true,
            include_slide_comment: true,
            include_slide_preview: command.capability === 'preview.snapshot',
            slide_preview_size: command.capability === 'preview.snapshot'
              ? String(payload.previewSize || '320x180')
              : undefined
          }
        );
        return { currentPresentation };
      }

      case 'presentation.navigation': {
        const action = String(payload.action || '');
        if (action === 'next') await this.api.request('ActionNext');
        else if (action === 'previous') await this.api.request('ActionPrevious');
        else if (action === 'goto') {
          if (!Number.isInteger(payload.index) || payload.index < 0) {
            throw new Error('invalid_slide_index');
          }
          await this.api.request('ActionGoToIndex', { index: payload.index });
        } else {
          throw new Error('invalid_navigation_action');
        }
        const currentPresentation = await this.api.request<CurrentPresentation | null>(
          'GetCurrentPresentation',
          { include_slides: true, include_slide_comment: true }
        );
        return { currentPresentation };
      }

      case 'presentation.clear':
        await this.api.request('CloseCurrentPresentation');
        return { currentPresentation: null };

      case 'presentation.background.read': {
        const currentBackground = await this.api.request<HolyricsBackground | null>(
          'GetCurrentBackground'
        );
        const backgrounds = await this.api.request<HolyricsBackground[]>(
          'GetBackgrounds',
          {
            type: payload.type ? String(payload.type) : undefined,
            tag: payload.tag ? String(payload.tag) : undefined,
            tags: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined,
            intersection: Boolean(payload.intersection)
          }
        );
        const limited = Array.isArray(backgrounds) ? backgrounds.slice(0, 40) : [];
        const ids = limited
          .map(item => String(item.id || ''))
          .filter(Boolean);
        const thumbnails = ids.length
          ? await this.api.request<HolyricsThumbnail[]>('GetThumbnail', {
              ids,
              type: 'background'
            })
          : [];
        const thumbnailById = new Map(
          (Array.isArray(thumbnails) ? thumbnails : [])
            .map(item => [String(item.id || ''), String(item.image || '')] as const)
            .filter(([id, image]) => Boolean(id && image))
        );

        return {
          currentBackground,
          backgrounds: limited.map(item => ({
            ...item,
            thumbnail: thumbnailById.get(String(item.id || '')) || undefined
          }))
        };
      }

      case 'presentation.background.set': {
        const id = String(payload.id || '');
        if (!id) throw new Error('background_id_required');
        await this.api.request('SetCurrentBackground', {
          id,
          type: payload.type ? String(payload.type) : undefined
        });
        const currentBackground = await this.api.request<HolyricsBackground | null>(
          'GetCurrentBackground'
        );
        return { currentBackground };
      }

      case 'presentation.screen.mode': {
        const mode = String(payload.mode || 'normal');
        if (!['normal', 'wallpaper', 'blank', 'black'].includes(mode)) {
          throw new Error('invalid_screen_mode');
        }

        await this.api.request('SetF8', { enable: mode === 'wallpaper' });
        await this.api.request('SetF9', { enable: mode === 'blank' });
        await this.api.request('SetF10', { enable: mode === 'black' });

        this.lastState = {
          health: 'online',
          updatedAt: new Date().toISOString(),
          observed: {
            ...this.lastState.observed,
            screenMode: mode
          }
        };
        return { screenMode: mode };
      }

      case 'bible.search': {
        const text = String(payload.text || payload.reference || '');
        if (!text.trim()) throw new Error('bible_search_text_required');
        const matches = await this.api.request<unknown>('IdentifyVerseReferences', {
          value: text,
          language_id: payload.languageId ? String(payload.languageId) : undefined
        });
        return { matches };
      }

      case 'bible.versions.read': {
        const action = this.grantedActions.has('GetBibleVersionsV2')
          ? 'GetBibleVersionsV2'
          : this.grantedActions.has('GetBibleVersions')
            ? 'GetBibleVersions'
            : null;
        if (!action) throw new Error('bible_versions_unavailable');
        const versions = await this.api.request<unknown[]>(action);
        return { versions, sourceAction: action };
      }

      case 'bible.books.read': {
        const languageId = String(payload.languageId || '').trim();
        if (!languageId) throw new Error('bible_language_id_required');
        const books = await this.api.request<unknown[]>('GetBibleBooks', {
          language_id: languageId
        });
        return { books, languageId };
      }

      case 'text.search': {
        const text = String(payload.text || '').trim();
        if (!text) throw new Error('text_search_text_required');
        const results = await this.api.request<unknown[]>('SearchText', {
          text,
          fields: String(payload.fields || 'id,title,folder,slides')
        });
        return { results };
      }

      case 'text.present': {
        const id = String(payload.id || '').trim();
        if (!id) throw new Error('text_id_required');
        await this.api.request('ShowText', {
          id,
          initial_index: Number.isInteger(payload.initialIndex)
            ? payload.initialIndex
            : 0
        });
        const currentPresentation = this.supported.has('presentation.slides.read')
          ? await this.api.request<CurrentPresentation | null>('GetCurrentPresentation')
          : null;
        return { textId: id, currentPresentation };
      }

      case 'text.quick.present': {
        const text = String(payload.text || '').trim();
        const slides = Array.isArray(payload.slides) ? payload.slides : undefined;
        if (!text && !slides?.length) throw new Error('quick_text_required');
        await this.api.request('ShowQuickPresentation', {
          ...(text ? { text } : {}),
          ...(slides?.length ? { slides } : {}),
          ...(payload.theme && typeof payload.theme === 'object'
            ? { theme: payload.theme }
            : {}),
          ...(payload.customTheme && typeof payload.customTheme === 'object'
            ? { custom_theme: payload.customTheme }
            : {}),
          ...(payload.automatic && typeof payload.automatic === 'object'
            ? { automatic: payload.automatic }
            : {}),
          initial_index: Number.isInteger(payload.initialIndex)
            ? payload.initialIndex
            : 0
        });
        const currentPresentation = this.supported.has('presentation.slides.read')
          ? await this.api.request<CurrentPresentation | null>('GetCurrentPresentation')
          : null;
        return { quickPresentation: true, currentPresentation };
      }

      case 'announcement.read': {
        const announcements = await this.api.request<unknown[]>('GetAnnouncements');
        return { announcements };
      }

      case 'announcement.present': {
        const id = String(payload.id || '').trim();
        const name = String(payload.name || '').trim();
        const ids = Array.isArray(payload.ids)
          ? payload.ids.map(String).filter(Boolean)
          : [];
        const names = Array.isArray(payload.names)
          ? payload.names.map(String).filter(Boolean)
          : [];
        if (!id && !name && !ids.length && !names.length) {
          throw new Error('announcement_reference_required');
        }
        await this.api.request('ShowAnnouncement', {
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
          ...(ids.length ? { ids } : {}),
          ...(names.length ? { names } : {}),
          ...(payload.automatic && typeof payload.automatic === 'object'
            ? { automatic: payload.automatic }
            : {})
        });
        const currentPresentation = this.supported.has('presentation.slides.read')
          ? await this.api.request<CurrentPresentation | null>('GetCurrentPresentation')
          : null;
        return { announcementPresented: true, currentPresentation };
      }

      case 'songs.search': {
        const results = await this.api.request<unknown[]>('SearchLyrics', {
          text: String(payload.text || ''),
          title: payload.title !== false,
          artist: payload.artist !== false,
          note: Boolean(payload.note),
          lyrics: Boolean(payload.lyrics),
          fields: String(payload.fields || 'id,title,artist,author,key,bpm')
        });
        return { results };
      }

      case 'songs.create': {
        const title = String(payload.title || '').trim();
        const lyrics = String(payload.lyrics || '').trim();
        if (!title) throw new Error('song_title_required');
        if (!lyrics) throw new Error('song_lyrics_required');
        if (!this.api.createSongDraft) throw new Error('song_create_unavailable');

        await this.api.createSongDraft({
          title,
          lyrics,
          artist: payload.artist ? String(payload.artist) : undefined,
          author: payload.author ? String(payload.author) : undefined,
          copyright: payload.copyright ? String(payload.copyright) : undefined,
          note: payload.note ? String(payload.note) : undefined,
          key: payload.key ? String(payload.key) : undefined,
          bpm: typeof payload.bpm === 'number' ? payload.bpm : undefined,
          tags: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined
        });

        return {
          creationRequested: true,
          title,
          completion: 'provider_editor_opened',
          requiresProviderSave: true
        };
      }

      case 'songs.present': {
        const id = String(payload.id || '');
        if (!id) throw new Error('song_id_required');
        await this.api.request('ShowLyrics', {
          id,
          initial_index: Number.isInteger(payload.initialIndex)
            ? payload.initialIndex
            : 0
        });
        const currentPresentation = this.supported.has('presentation.slides.read')
          ? await this.api.request<CurrentPresentation | null>('GetCurrentPresentation')
          : null;
        return { songId: id, currentPresentation };
      }

      case 'playlist.sync': {
        const ids = Array.isArray(payload.ids)
          ? payload.ids.map(String).filter(Boolean)
          : [];
        if (!ids.length) throw new Error('playlist_ids_required');

        const existing = await this.api.request<Array<{ id?: string }>>('GetLyricsPlaylist');
        const existingIds = existing.map(item => String(item.id || '')).filter(Boolean);
        const alreadyEqual =
          existingIds.length === ids.length &&
          existingIds.every((id, index) => id === ids[index]);

        if (!alreadyEqual) {
          if (existing.length > 0) {
            await this.api.request('RemoveFromLyricsPlaylist', {
              indexes: existing.map((_, index) => index)
            });
          }
          await this.api.request('AddLyricsToPlaylist', {
            ids,
            index: -1,
            media_playlist: false
          });
        }

        return {
          playlistSongIds: ids,
          replacedSongIds: existingIds,
          changed: !alreadyEqual
        };
      }

      case 'playlist.write': {
        const ids = Array.isArray(payload.ids)
          ? payload.ids.map(String).filter(Boolean)
          : payload.id ? [String(payload.id)] : [];
        if (!ids.length) throw new Error('playlist_ids_required');
        await this.api.request('AddLyricsToPlaylist', {
          ids,
          index: Number.isInteger(payload.index) ? payload.index : -1,
          media_playlist: Boolean(payload.mediaPlaylist),
          event_id: payload.eventId ? String(payload.eventId) : undefined
        });
        return { addedSongIds: ids };
      }

      case 'bible.present': {
        const input: Record<string, unknown> = {};
        if (payload.id) input.id = String(payload.id);
        if (Array.isArray(payload.ids)) input.ids = payload.ids.map(String);
        if (payload.reference) input.references = String(payload.reference);
        if (payload.references) input.references = String(payload.references);
        if (payload.version) input.version = String(payload.version);
        if (payload.quickPresentation !== undefined) {
          input.quick_presentation = Boolean(payload.quickPresentation);
        }
        if (!input.id && !input.ids && !input.references) {
          throw new Error('bible_reference_required');
        }
        await this.api.request('ShowVerse', input);
        const currentPresentation = this.supported.has('presentation.slides.read')
          ? await this.api.request<CurrentPresentation | null>('GetCurrentPresentation', {
              include_slides: true,
              include_slide_comment: true
            })
          : null;
        return { biblePresentationRequested: input, currentPresentation };
      }

      case 'media.search': {
        const kind = String(payload.kind || 'video');
        const action =
          kind === 'audio' ? 'GetAudios' :
          kind === 'image' ? 'GetImages' :
          kind === 'video' ? 'GetVideos' :
          null;
        if (!action) throw new Error('unsupported_media_kind');

        const results = await this.api.request<unknown[]>(action, {
          folder: payload.folder ? String(payload.folder) : undefined,
          filter: payload.filter ? String(payload.filter) : undefined,
          include_metadata: payload.includeMetadata !== false,
          include_thumbnail: Boolean(payload.includeThumbnail)
        });
        return { mediaType: kind, results };
      }

      case 'media.open': {
        const kind = String(payload.kind || '');
        const file = String(payload.file || '');
        if (!file) throw new Error('media_file_required');

        if (kind === 'audio') {
          await this.api.request('PlayAudio', {
            file,
            settings: payload.settings && typeof payload.settings === 'object'
              ? payload.settings
              : undefined
          });
        } else if (kind === 'video') {
          await this.api.request('PlayVideo', {
            file,
            settings: payload.settings && typeof payload.settings === 'object'
              ? payload.settings
              : undefined
          });
        } else if (kind === 'image') {
          await this.api.request('ShowImage', {
            file,
            automatic: payload.automatic && typeof payload.automatic === 'object'
              ? payload.automatic
              : undefined
          });
        } else {
          throw new Error('unsupported_media_kind');
        }

        return { mediaType: kind, file, opened: true };
      }

      case 'stage.message':
        await this.api.request('SetTextCommunicationPanel', {
          text: String(payload.text || ''),
          show: payload.show !== false,
          display_ahead: payload.displayAhead !== false,
          theme: payload.theme && typeof payload.theme === 'object'
            ? payload.theme
            : undefined
        });
        return { stageMessageVisible: payload.show !== false };

      default:
        throw new Error('capability_not_supported');
    }
  }

  private result(
    command: LiveCommand,
    started: number,
    accepted: boolean,
    errorCode: string,
    recoverable: boolean
  ): CommandResult {
    return {
      commandId: command.id,
      providerInstanceId: this.descriptor.id,
      accepted,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      errorCode,
      recoverable
    };
  }
}
