import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Capability,
  CommandResult,
  ProviderLink,
  ServiceItem
} from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';
import { useLiveCueCoordinator } from './LiveCueCoordinator';
import {
  loadLiveShortcutBindings,
  saveLiveShortcutBindings,
  useLiveOperatorShortcuts,
  type LiveShortcutBindings
} from './useLiveOperatorShortcuts';
import { createClientId } from './clientId';
import { BibleWorkspace } from './BibleWorkspace';
import {
  UniversalSearchIndex,
  type UniversalSearchHit
} from './universalSearchIndex';

type Controller = ReturnType<typeof useLiveNode>;
type ToolMode = 'song' | 'bible' | 'media' | 'text' | 'stage';

interface SearchSongResult {
  id: string;
  providerId: string;
  title: string;
  artist?: string;
  key?: string;
  bpm?: number;
}

interface SongSection {
  id: string;
  label: string;
  startIndex: number;
  endIndex: number;
}

interface SearchTextResult {
  id: string;
  providerId: string;
  title: string;
  text?: string;
}

interface AnnouncementResult {
  id: string;
  providerId: string;
  name: string;
  text?: string;
  archived?: boolean;
}

interface SearchMediaResult {
  name: string;
  isDir?: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
}

interface PreparedProgramCue {
  id: string;
  kind: 'song' | 'bible' | 'media' | 'text' | 'announcement';
  title: string;
  subtitle?: string;
  capability:
    | 'songs.present'
    | 'bible.present'
    | 'media.open'
    | 'text.present'
    | 'text.quick.present'
    | 'announcement.present';
  payload: Record<string, unknown>;
  targetProviderIds?: string[];
  serviceItemId?: string;
  previewDataUrl?: string;
  liveDropAssetId?: string;
}

interface BackgroundOption {
  id: string;
  type?: string;
  name: string;
  thumbnail?: string;
  tags?: string[];
}

function backgroundThumbnailUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (normalized.startsWith('data:image/')) return normalized;
  const mime = normalized.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${normalized}`;
}

function getBackgroundOptions(results: CommandResult[]): BackgroundOption[] {
  for (const result of results) {
    const raw = result.observedState?.backgrounds;
    if (!Array.isArray(raw)) continue;
    return raw
      .filter(value => value && typeof value === 'object')
      .map(value => {
        const item = value as Record<string, unknown>;
        return {
          id: String(item.id || ''),
          type: item.type ? String(item.type) : undefined,
          name: String(item.name || item.id || ''),
          thumbnail: backgroundThumbnailUrl(
            typeof item.thumbnail === 'string' ? item.thumbnail : undefined
          ),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : undefined
        };
      })
      .filter(item => item.id && item.name);
  }
  return [];
}

function getSongResults(results: CommandResult[]): SearchSongResult[] {
  const normalized = results.flatMap(result => {
    const value = result.observedState?.results;
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const song = item as Record<string, unknown>;
        return {
          id: String(song.id || ''),
          providerId: result.providerInstanceId,
          title: String(song.title || ''),
          artist: song.artist ? String(song.artist) : undefined,
          key: song.key ? String(song.key) : undefined,
          bpm: typeof song.bpm === 'number' ? song.bpm : undefined
        };
      });
  }).filter(value => value.id && value.providerId && value.title);

  const seen = new Set<string>();
  return normalized.filter(song => {
    const key = `${song.providerId}:${song.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 18);
}

function normalizeSectionLabel(slide: Record<string, unknown>, index: number): string {
  const raw = [
    slide.slide_description,
    slide.description,
    slide.slide_type,
    slide.type
  ].find(value => typeof value === 'string' && value.trim()) as string | undefined;

  if (!raw) return `Slide ${index + 1}`;
  return raw
    .replace(/^\s*[\[(]+|[\])]+\s*$/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSongSections(slides: Array<Record<string, unknown>>): SongSection[] {
  const sections: SongSection[] = [];
  slides.forEach((slide, index) => {
    const label = normalizeSectionLabel(slide, index);
    const previous = sections[sections.length - 1];
    if (previous && previous.label.toLocaleLowerCase() === label.toLocaleLowerCase()) {
      previous.endIndex = index;
      return;
    }
    sections.push({
      id: `section:${index}:${label.toLocaleLowerCase()}`,
      label,
      startIndex: index,
      endIndex: index
    });
  });
  return sections;
}

function looksLikeBibleReference(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return /^(?:[1-3]\s*)?[\p{L}.ªº]+(?:\s+[\p{L}.ªº]+)*\s+\d+(?:(?:\s*[:.]\s*|\s+)\d+(?:\s*[-–]\s*\d+)?)?$/iu.test(text);
}

function getPresentationFromResults(results: CommandResult[]): Record<string, unknown> | null {
  for (const result of results) {
    const value = result.observedState?.currentPresentation;
    if (value && typeof value === 'object') {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function slidePreviewUrl(slide: Record<string, unknown> | undefined): string | null {
  const preview = slide?.preview;
  if (typeof preview !== 'string' || !preview.trim()) return null;
  const value = preview.trim();
  if (value.startsWith('data:image/')) return value;
  const mime = value.startsWith('iVBOR')
    ? 'image/png'
    : value.startsWith('/9j/')
      ? 'image/jpeg'
      : 'image/jpeg';
  return `data:${mime};base64,${value}`;
}

function samePresentationFrame(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null
): boolean {
  if (!left || !right) return false;
  return (
    String(left.id || '') === String(right.id || '') &&
    Number(left.slide_number) === Number(right.slide_number)
  );
}

function mediaThumbnailUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (normalized.startsWith('data:image/')) return normalized;
  const mime = normalized.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${normalized}`;
}

function getTextResults(results: CommandResult[]): SearchTextResult[] {
  const normalized = results.flatMap(result => {
    const value = result.observedState?.results;
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const text = item as Record<string, unknown>;
        const slides = Array.isArray(text.slides)
          ? text.slides.filter(value => value && typeof value === 'object')
          : [];
        const firstSlide = slides[0] as Record<string, unknown> | undefined;
        const preview =
          typeof firstSlide?.text === 'string'
            ? firstSlide.text
            : typeof firstSlide?.styled_text === 'string'
              ? firstSlide.styled_text
              : undefined;
        return {
          id: String(text.id || ''),
          providerId: result.providerInstanceId,
          title: String(text.title || text.name || ''),
          text: preview
        };
      });
  }).filter(item => item.id && item.providerId && item.title);

  const seen = new Set<string>();
  return normalized.filter(item => {
    const key = `${item.providerId}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function getAnnouncementResults(results: CommandResult[]): AnnouncementResult[] {
  const normalized = results.flatMap(result => {
    const value = result.observedState?.announcements;
    if (!Array.isArray(value)) return [];
    return value
      .filter(item => item && typeof item === 'object')
      .map(item => {
        const announcement = item as Record<string, unknown>;
        return {
          id: String(announcement.id || ''),
          providerId: result.providerInstanceId,
          name: String(announcement.name || ''),
          text: typeof announcement.text === 'string' ? announcement.text : undefined,
          archived: Boolean(announcement.archived)
        };
      });
  }).filter(item => item.id && item.providerId && item.name && !item.archived);

  const seen = new Set<string>();
  return normalized.filter(item => {
    const key = `${item.providerId}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function getMediaResults(results: CommandResult[]): SearchMediaResult[] {
  return results
    .flatMap(result => {
      const value = result.observedState?.results;
      return Array.isArray(value) ? value : [];
    })
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      return {
        name: String(item.name || ''),
        isDir: Boolean(item.isDir),
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : undefined,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined,
        thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : undefined
      };
    })
    .filter(item => item.name)
    .slice(0, 18);
}

export function LiveControlPanel({
  controller,
  actorId,
  liveSessionId,
  servicePlanEnabled = true,
  touchPrimary = false
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
  servicePlanEnabled?: boolean;
  touchPrimary?: boolean;
}) {
  const { t } = useTranslation();
  const cueCoordinator = useLiveCueCoordinator();
  const [songQuery, setSongQuery] = useState('');
  const [songResults, setSongResults] = useState<SearchSongResult[]>([]);
  const [universalQuery, setUniversalQuery] = useState('');
  const universalInputRef = useRef<HTMLInputElement | null>(null);
  const [universalScope, setUniversalScope] = useState<'auto' | 'song' | 'bible' | 'media' | 'text'>('auto');
  const [localSearchHits, setLocalSearchHits] = useState<UniversalSearchHit[]>([]);
  const [preparedSearchHit, setPreparedSearchHit] = useState<UniversalSearchHit | null>(null);
  const [bibleCommand, setBibleCommand] = useState<{ text: string; nonce: number } | null>(null);
  const [followLive, setFollowLive] = useState(true);
  const [shortcutBindings, setShortcutBindings] = useState<LiveShortcutBindings>(
    () => loadLiveShortcutBindings()
  );
  const [mediaKind, setMediaKind] = useState<'video' | 'image' | 'audio'>('video');
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaResults, setMediaResults] = useState<SearchMediaResult[]>([]);
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<SearchTextResult[]>([]);
  const [quickText, setQuickText] = useState('');
  const [announcements, setAnnouncements] = useState<AnnouncementResult[]>([]);
  const [announcementsLoaded, setAnnouncementsLoaded] = useState(false);
  const [stageText, setStageText] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('song');
  const [preparedCue, setPreparedCue] = useState<PreparedProgramCue | null>(null);
  const [previewPresentation, setPreviewPresentation] = useState<Record<string, unknown> | null>(null);
  const [selectedSlideIndex, setSelectedSlideIndex] = useState<number | null>(null);
  const [backgroundPickerOpen, setBackgroundPickerOpen] = useState(false);
  const [backgrounds, setBackgrounds] = useState<BackgroundOption[]>([]);
  const [selectedBackground, setSelectedBackground] = useState<BackgroundOption | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [playlistSyncArmed, setPlaylistSyncArmed] = useState(false);
  const clearTimer = useRef<number | null>(null);
  const playlistSyncTimer = useRef<number | null>(null);
  const toolSurfaceRef = useRef<HTMLSpanElement | null>(null);
  const serviceSurfaceRef = useRef<HTMLSpanElement | null>(null);
  const previewRequestSignature = useRef<string>('');
  const slideRailRef = useRef<HTMLDivElement | null>(null);
  const sectionRailRef = useRef<HTMLDivElement | null>(null);
  const previousFrameSignature = useRef('');
  const tapTarget = useRef<{ key: string; at: number } | null>(null);
  const criticalActionAt = useRef<{ key: string; at: number } | null>(null);

  const providers = controller.nodeState?.providers || [];
  const servicePlan = servicePlanEnabled
    ? controller.nodeState?.state.servicePlan || null
    : null;
  const providerLinks = servicePlanEnabled
    ? controller.nodeState?.state.providerLinks || []
    : [];
  const activeServiceItemId = controller.nodeState?.state.activeServiceItemId || null;
  const universalIndex = useMemo(() => {
    const binding = controller.credential?.binding;
    const scope = binding
      ? `${binding.organizationId}:${binding.venueId}:${binding.liveSystemId}`
      : 'unpaired';
    return new UniversalSearchIndex(`nestlive:universal-search:${scope}`);
  }, [
    controller.credential?.binding.organizationId,
    controller.credential?.binding.venueId,
    controller.credential?.binding.liveSystemId
  ]);
  const capabilitySet = useMemo(
    () => new Set(
      providers
        .filter(provider => provider.health === 'online' || provider.health === 'degraded')
        .flatMap(provider => provider.capabilities)
    ),
    [providers]
  );

  const serviceHorizon = useMemo(() => {
    if (!servicePlan?.items.length) {
      return {
        current: null,
        next: null,
        activeIndex: -1
      };
    }

    const activeIndex = activeServiceItemId
      ? servicePlan.items.findIndex(item => item.id === activeServiceItemId)
      : servicePlan.items.findIndex(item => item.state === 'live');

    const current = activeIndex >= 0 ? servicePlan.items[activeIndex] : null;
    const next =
      servicePlan.items[activeIndex >= 0 ? activeIndex + 1 : 0] ||
      null;

    return { current, next, activeIndex };
  }, [activeServiceItemId, servicePlan]);

  const currentPresentation = useMemo(() => {
    for (const provider of providers) {
      const candidate = provider.observed?.currentPresentation;
      if (candidate && typeof candidate === 'object') {
        return candidate as Record<string, unknown>;
      }
    }
    return null;
  }, [providers]);

  const can = (capability: Capability) => capabilitySet.has(capability);
  const providerSupports = (providerId: string, capability: Capability) => providers.some(provider =>
    provider.providerId === providerId &&
    (provider.health === 'online' || provider.health === 'degraded') &&
    provider.capabilities.includes(capability)
  );
  const canPreviewSnapshot = capabilitySet.has('preview.snapshot');
  const canBackgroundRead = capabilitySet.has('presentation.background.read');
  const canBackgroundSet = capabilitySet.has('presentation.background.set');
  const presentationProviders = providers.filter(provider =>
    (provider.health === 'online' || provider.health === 'degraded') &&
    provider.capabilities.some(capability =>
      capability.startsWith('presentation.') || capability === 'preview.snapshot'
    )
  );
  const presentationRouteMissing =
    presentationProviders.length > 1 &&
    !controller.nodeState?.routing?.presentation;

  const playlistSyncPlan = useMemo(() => {
    const songItems = servicePlan?.items.filter(item => item.type === 'song') || [];
    if (!songItems.length) {
      return {
        hasSongs: false,
        ready: false,
        providerId: '',
        providerName: '',
        ids: [] as string[],
        reason: 'no_songs'
      };
    }

    const links = songItems.map(item =>
      item.providerLinkId
        ? providerLinks.find(link => link.id === item.providerLinkId) || null
        : null
    );
    const resolvedLinks = links.filter(
      (link): link is ProviderLink => Boolean(link?.externalId)
    );
    const complete = resolvedLinks.length === songItems.length;
    const providerIds = new Set(
      resolvedLinks.map(link => link.providerInstanceId)
    );
    const providerId = providerIds.size === 1 ? [...providerIds][0]! : '';
    const provider = providerId
      ? providers.find(candidate => candidate.providerId === providerId)
      : undefined;
    const providerReady = Boolean(
      provider &&
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('playlist.sync')
    );

    return {
      hasSongs: true,
      ready: complete && providerIds.size === 1 && providerReady,
      providerId,
      providerName: provider?.displayName || provider?.providerKey || '',
      ids: complete ? resolvedLinks.map(link => link.externalId) : [],
      reason: !complete
        ? 'unresolved'
        : providerIds.size !== 1
          ? 'multiple_providers'
          : !provider
            ? 'provider_offline'
            : !provider.capabilities.includes('playlist.sync')
              ? 'capability_missing'
              : provider.health !== 'online' && provider.health !== 'degraded'
                ? 'provider_offline'
                : ''
    };
  }, [providerLinks, providers, servicePlan]);

  const commandFailure = (code: string) => t(
    `liveControls.errors.${code}`,
    {
      defaultValue: t('liveControls.commandFailed', { code })
    }
  );
  const toolAvailability = useMemo<Record<ToolMode, boolean>>(() => ({
    song: capabilitySet.has('songs.search') || capabilitySet.has('songs.present'),
    bible: capabilitySet.has('bible.present'),
    media: capabilitySet.has('media.search') || capabilitySet.has('media.open'),
    text:
      capabilitySet.has('text.search') ||
      capabilitySet.has('text.present') ||
      capabilitySet.has('text.quick.present') ||
      capabilitySet.has('announcement.read') ||
      capabilitySet.has('announcement.present'),
    stage: capabilitySet.has('stage.message')
  }), [capabilitySet]);

  useEffect(() => {
    setPreparedCue(null);
    setSelectedSlideIndex(null);
    setBackgroundPickerOpen(false);
    setSelectedBackground(null);
    setMessage(null);
    setClearArmed(false);
    setPlaylistSyncArmed(false);
  }, [liveSessionId]);

  useEffect(() => () => {
    if (clearTimer.current) window.clearTimeout(clearTimer.current);
    if (playlistSyncTimer.current) window.clearTimeout(playlistSyncTimer.current);
  }, []);

  function openTool(mode: ToolMode) {
    setToolMode(mode);
    window.requestAnimationFrame(() => {
      toolSurfaceRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    });
  }

  function focusUniversalSearch() {
    universalInputRef.current?.focus();
    universalInputRef.current?.select();
    universalInputRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }

  function openServiceHorizon() {
    serviceSurfaceRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  }

  useEffect(() => {
    if (toolAvailability[toolMode]) return;
    const fallback = (['song', 'bible', 'media', 'text', 'stage'] as ToolMode[])
      .find(mode => toolAvailability[mode]);
    if (fallback) setToolMode(fallback);
  }, [toolAvailability, toolMode]);

  useEffect(() => {
    if (
      toolMode === 'text' &&
      can('announcement.read') &&
      !announcementsLoaded &&
      busy === null
    ) {
      void loadAnnouncements();
    }
    // Announcement loading is progressive and does not block the operator.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolMode, announcementsLoaded, capabilitySet, busy]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    const refresh = async () => {
      if (stopped || polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        await controller.refreshState();
      } catch {
        // The regular connection heartbeat owns degraded/offline UX.
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 900);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [controller.refreshState]);

  useEffect(() => {
    if (!canPreviewSnapshot || !currentPresentation) return;

    const signature = `${String(currentPresentation.id || '')}:${String(currentPresentation.slide_number || '')}`;
    if (!signature || previewRequestSignature.current === signature) return;
    previewRequestSignature.current = signature;

    let cancelled = false;
    void controller.executeCommand({
      capability: 'preview.snapshot',
      payload: { previewSize: '640x360' },
      liveSessionId,
      actorId,
      safetyLevel: 'normal'
    }).then(results => {
      if (cancelled) return;
      const presentation = getPresentationFromResults(results);
      if (presentation) setPreviewPresentation(presentation);
    }).catch(() => {
      if (!cancelled) previewRequestSignature.current = '';
    });

    return () => {
      cancelled = true;
    };
  }, [
    actorId,
    canPreviewSnapshot,
    controller,
    currentPresentation,
    liveSessionId
  ]);

  // Automatically hydrate the operator deck with image previews only when the
  // presentation frame changes. Background health polling stays lightweight.
  async function run(
    key: string,
    capability: Capability,
    payload: Record<string, unknown>,
    safetyLevel: 'normal' | 'guarded' = 'normal',
    serviceItemId?: string,
    targetProviderIds?: string[],
    confirmed = false
  ): Promise<CommandResult[]> {
    setBusy(key);
    setMessage(null);
    try {
      const results = await controller.executeCommand({
        capability,
        payload,
        liveSessionId,
        serviceItemId,
        actorId,
        targetProviderIds,
        safetyLevel,
        confirmed
      });
      const rejected = results.find(result => !result.accepted);
      if (rejected) {
        setMessage(commandFailure(rejected.errorCode || 'provider_error'));
      }
      return results;
    } catch (error) {
      setMessage(commandFailure(error instanceof Error ? error.message : 'unknown'));
      return [];
    } finally {
      setBusy(null);
    }
  }

  async function applyScreenMode(mode: 'normal' | 'wallpaper' | 'blank' | 'black') {
    if (!can('presentation.screen.mode')) return;
    await run(`screen-mode:${mode}`, 'presentation.screen.mode', { mode });
  }

  async function openBackgroundPicker() {
    setBackgroundPickerOpen(true);
    if (!canBackgroundRead || busy !== null) return;

    const results = await run('background-library', 'presentation.background.read', {});
    const options = getBackgroundOptions(results);
    setBackgrounds(options);

    const currentId = results
      .map(result => result.observedState?.currentBackground)
      .find(value => value && typeof value === 'object') as Record<string, unknown> | undefined;
    const active = options.find(option => option.id === String(currentId?.id || ''));
    if (active) setSelectedBackground(active);
  }

  async function handleScreenMode(mode: 'normal' | 'wallpaper' | 'blank' | 'black') {
    if (mode === 'wallpaper') {
      await openBackgroundPicker();
      return;
    }
    await applyScreenMode(mode);
  }

  async function takeSelectedBackground() {
    if (!selectedBackground || !canBackgroundSet || busy !== null) return;
    const results = await run(
      'background-take',
      'presentation.background.set',
      { id: selectedBackground.id, type: selectedBackground.type }
    );
    if (!results.some(result => result.accepted)) return;
    await applyScreenMode('wallpaper');
    setBackgroundPickerOpen(false);
  }

  async function showCurrentBackgroundFallback() {
    await applyScreenMode('wallpaper');
    setBackgroundPickerOpen(false);
  }

  async function refreshPresentationPreview() {
    if (!can('presentation.preview')) return;
    const results = await run('presentation-preview', 'presentation.preview', {});
    setPreviewPresentation(getPresentationFromResults(results));
  }

  async function navigatePresentation(action: 'next' | 'previous') {
    if (!can('presentation.navigation')) return;

    const armedVisual = cueCoordinator?.armedVisualCue || null;
    const credential = controller.credential;

    if (action === 'next' && armedVisual && credential) {
      setBusy('next');
      setMessage(null);
      try {
        const sceneId = createClientId();
        const result = await controller.executeScene({
          liveSessionId,
          actorId,
          scene: {
            id: sceneId,
            organizationId: credential.binding.organizationId,
            venueId: credential.binding.venueId,
            liveSystemId: credential.binding.liveSystemId,
            name: 'Linked Take',
            actions: [
              {
                id: 'presentation-next',
                capability: 'presentation.navigation',
                targetProviderIds: [],
                outputTargets: ['main'],
                payload: { action: 'next' },
                safetyLevel: 'normal'
              },
              {
                id: 'visual-take',
                capability: 'visual.clip.trigger',
                targetProviderIds: [armedVisual.providerId],
                outputTargets: ['main'],
                payload: { clipId: armedVisual.clipId },
                safetyLevel: 'normal'
              }
            ]
          }
        });

        const presentationResults = result.actions
          .find(item => item.actionId === 'presentation-next')
          ?.results || [];
        const presentation = getPresentationFromResults(presentationResults);
        if (presentation) setPreviewPresentation(presentation);

        const visualAccepted = result.actions
          .find(item => item.actionId === 'visual-take')
          ?.results.some(item => item.accepted);
        if (visualAccepted) cueCoordinator?.clearVisualCue();

        if (result.status !== 'completed') {
          setMessage(t('liveControls.linkedTakePartial'));
        }
      } catch (error) {
        setMessage(commandFailure(error instanceof Error ? error.message : 'unknown'));
      } finally {
        setBusy(null);
      }
      return;
    }

    const results = await run(action, 'presentation.navigation', { action });
    const presentation = getPresentationFromResults(results);
    if (presentation) setPreviewPresentation(presentation);
  }

  async function goToSlide(index: number) {
    if (!can('presentation.navigation') || !Number.isInteger(index) || index < 0) return;
    const results = await run(
      `goto:${index}`,
      'presentation.navigation',
      { action: 'goto', index }
    );
    const presentation = getPresentationFromResults(results);
    if (presentation) setPreviewPresentation(presentation);
    if (results.some(result => result.accepted)) {
      setSelectedSlideIndex(null);
      setFollowLive(true);
    }
  }

  function buildServiceItemCue(item: ServiceItem): PreparedProgramCue | null {
    if (item.type === 'song') {
      if (!item.providerLinkId) return null;
      const link = providerLinks.find(candidate => candidate.id === item.providerLinkId);
      if (!link || !providerSupports(link.providerInstanceId, 'songs.present')) return null;
      return {
        id: `service-item:${item.id}`,
        kind: 'song',
        title: item.title,
        subtitle: t('liveControls.fromRunOfShow'),
        capability: 'songs.present',
        payload: { id: link.externalId },
        targetProviderIds: [link.providerInstanceId],
        serviceItemId: item.id
      };
    }

    if (item.type === 'bible') {
      const payload = item.payload || {};
      const providerId = String(payload.providerId || '').trim();
      if (providerId
        ? !providerSupports(providerId, 'bible.present')
        : !can('bible.present')) return null;
      const ids = Array.isArray(payload.ids)
        ? payload.ids.map(String).filter(Boolean)
        : [];
      const reference = String(
        payload.references ||
        payload.reference ||
        ''
      ).trim();
      if (!ids.length && !reference) return null;
      return {
        id: `service-item:${item.id}`,
        kind: 'bible',
        title: item.title,
        subtitle: reference || t('liveControls.fromRunOfShow'),
        capability: 'bible.present',
        payload: {
          ...(ids.length ? { ids } : { references: reference }),
          ...(payload.version ? { version: String(payload.version) } : {})
        },
        targetProviderIds: providerId ? [providerId] : undefined,
        serviceItemId: item.id
      };
    }

    if (item.type === 'video' || item.type === 'image' || item.type === 'audio') {
      const payload = item.payload || {};
      const source = String(payload.source || 'provider');
      const providerId = String(payload.providerId || '').trim();
      if (providerId
        ? !providerSupports(providerId, 'media.open')
        : !can('media.open')) return null;

      if (source === 'live-drop') {
        const assetId = String(payload.assetId || '').trim();
        if (!assetId) return null;
        return {
          id: `service-item:${item.id}`,
          kind: 'media',
          title: item.title,
          subtitle: t('liveControls.serviceMediaLiveDrop'),
          capability: 'media.open',
          payload: {
            kind: item.type,
            liveDropAssetId: assetId
          },
          targetProviderIds: providerId ? [providerId] : undefined,
          serviceItemId: item.id,
          liveDropAssetId: assetId
        };
      }

      const file = String(payload.file || '').trim();
      if (!file) return null;
      return {
        id: `service-item:${item.id}`,
        kind: 'media',
        title: item.title,
        subtitle: String(payload.providerName || t('liveControls.fromRunOfShow')),
        capability: 'media.open',
        payload: {
          kind: item.type,
          file
        },
        targetProviderIds: providerId ? [providerId] : undefined,
        serviceItemId: item.id
      };
    }

    if (item.type === 'text') {
      const payload = item.payload || {};
      const source = String(payload.source || 'provider-text');
      const providerId = String(payload.providerId || '').trim();

      if (source === 'quick-text') {
        const text = String(payload.text || '').trim();
        const canPresentQuick = providerId
          ? providerSupports(providerId, 'text.quick.present')
          : can('text.quick.present');
        if (!text || !canPresentQuick) return null;
        return {
          id: `service-item:${item.id}`,
          kind: 'text',
          title: item.title,
          subtitle: t('liveControls.quickText'),
          capability: 'text.quick.present',
          payload: { text },
          targetProviderIds: providerId ? [providerId] : undefined,
          serviceItemId: item.id
        };
      }

      const id = String(payload.id || '').trim();
      const canPresentText = providerId
        ? providerSupports(providerId, 'text.present')
        : can('text.present');
      if (!id || !canPresentText) return null;
      return {
        id: `service-item:${item.id}`,
        kind: 'text',
        title: item.title,
        subtitle: t('liveControls.savedText'),
        capability: 'text.present',
        payload: { id },
        targetProviderIds: providerId ? [providerId] : undefined,
        serviceItemId: item.id
      };
    }

    if (item.type === 'announcement') {
      const payload = item.payload || {};
      const id = String(payload.id || '').trim();
      const name = String(payload.name || item.title || '').trim();
      const providerId = String(payload.providerId || '').trim();
      const canPresentAnnouncement = providerId
        ? providerSupports(providerId, 'announcement.present')
        : can('announcement.present');
      if (!canPresentAnnouncement || (!id && !name)) return null;
      return {
        id: `service-item:${item.id}`,
        kind: 'announcement',
        title: item.title,
        subtitle: t('liveControls.announcement'),
        capability: 'announcement.present',
        payload: id ? { id } : { name },
        targetProviderIds: providerId ? [providerId] : undefined,
        serviceItemId: item.id
      };
    }

    return null;
  }

  function prepareServiceItemCue(item: ServiceItem) {
    const cue = buildServiceItemCue(item);
    if (!cue) {
      setMessage(t('liveControls.serviceItemUnavailable', { type: item.type }));
      return;
    }
    setPreparedCue(cue);
  }

  function prepareServiceSong(item: ServiceItem) {
    prepareServiceItemCue(item);
  }

  function prepareNextServiceItem() {
    if (serviceHorizon.next) prepareServiceItemCue(serviceHorizon.next);
  }

  async function playServiceSong(item: ServiceItem) {
    if (item.type !== 'song' || !item.providerLinkId || busy !== null) return;
    const link = providerLinks.find(candidate => candidate.id === item.providerLinkId);
    if (!link || !providerSupports(link.providerInstanceId, 'songs.present')) {
      setMessage(t('liveControls.serviceItemUnavailable', { type: item.type }));
      return;
    }
    const results = await run(
      `service-song-now:${item.id}`,
      'songs.present',
      { id: link.externalId },
      'normal',
      item.id,
      [link.providerInstanceId]
    );
    if (results.some(result => result.accepted)) {
      setPreparedCue(null);
      setToolMode('song');
      setFollowLive(true);
    }
  }

  async function searchSongs(explicitQuery?: string) {
    const query = (explicitQuery ?? songQuery).trim();
    if (!query || !can('songs.search')) return;
    setSongQuery(query);
    const results = await run('song-search', 'songs.search', { text: query });
    setSongResults(getSongResults(results));
  }

  function prepareSong(song: SearchSongResult) {
    if (!can('songs.present')) return;
    setPreparedCue({
      id: `song:${song.providerId}:${song.id}`,
      kind: 'song',
      title: song.title,
      subtitle: [song.artist, song.key, song.bpm ? `${song.bpm} BPM` : '']
        .filter(Boolean)
        .join(' · '),
      capability: 'songs.present',
      payload: { id: song.id },
      targetProviderIds: [song.providerId]
    });
  }

  async function playSongNow(song: SearchSongResult) {
    if (!can('songs.present') || busy !== null) return;
    const results = await run(
      `song-now:${song.providerId}:${song.id}`,
      'songs.present',
      { id: song.id },
      'normal',
      undefined,
      [song.providerId]
    );
    if (results.some(result => result.accepted)) {
      setPreparedCue(null);
      setFollowLive(true);
    }
  }

  async function addSongToService(song: SearchSongResult, placement: 'next' | 'end') {
    if (!servicePlan || !controller.credential || busy !== null) return;

    const linkId = `live-link:${song.providerId}:${song.id}`;
    const existingLink = providerLinks.find(link =>
      link.providerInstanceId === song.providerId &&
      link.externalId === song.id
    );
    const link: ProviderLink = existingLink || {
      id: linkId,
      organizationId: controller.credential.binding.organizationId,
      venueId: controller.credential.binding.venueId,
      providerInstanceId: song.providerId,
      entityType: 'song',
      externalId: song.id,
      fingerprint: [song.title, song.artist || ''].join('|').toLocaleLowerCase(),
      lastVerifiedAt: new Date().toISOString(),
      metadata: { source: 'live-operator' }
    };

    if (can('playlist.write')) {
      const providerIndex = placement === 'next'
        ? Math.max(0, serviceHorizon.activeIndex + 1)
        : -1;
      const playlistResults = await run(
        `playlist-add:${song.providerId}:${song.id}`,
        'playlist.write',
        { id: song.id, index: providerIndex },
        'normal',
        undefined,
        [song.providerId]
      );
      if (playlistResults.some(result => !result.accepted)) return;
    }

    const runtimeItem: ServiceItem = {
      id: `live-song:${createClientId()}`,
      type: 'song',
      title: song.title,
      providerLinkId: link.id,
      state: 'planned',
      payload: {
        liveAdded: true,
        artist: song.artist,
        key: song.key,
        bpm: song.bpm
      }
    };
    const items = [...servicePlan.items];
    const insertIndex = placement === 'next'
      ? Math.max(0, serviceHorizon.activeIndex + 1)
      : items.length;
    items.splice(insertIndex, 0, runtimeItem);

    const links = existingLink ? providerLinks : [...providerLinks, link];
    await controller.cacheServicePlan({
      ...servicePlan,
      items,
      revision: servicePlan.revision + 1,
      metadata: {
        ...(servicePlan.metadata || {}),
        lastLiveEditAt: new Date().toISOString()
      }
    }, links);
    setMessage(t(
      placement === 'next'
        ? 'liveControls.songAddedNext'
        : 'liveControls.songAddedEnd',
      { title: song.title }
    ));
  }

  async function addOperatorItemToService(
    item: ServiceItem,
    placement: 'next' | 'end'
  ) {
    if (!servicePlan || busy !== null) return;
    setBusy(`service-add:${item.id}`);
    setMessage(null);
    try {
      const items = [...servicePlan.items];
      const insertIndex = placement === 'next'
        ? Math.max(0, serviceHorizon.activeIndex >= 0 ? serviceHorizon.activeIndex + 1 : 0)
        : items.length;
      items.splice(insertIndex, 0, item);

      await controller.cacheServicePlan({
        ...servicePlan,
        items,
        revision: servicePlan.revision + 1,
        metadata: {
          ...(servicePlan.metadata || {}),
          lastLiveEditAt: new Date().toISOString()
        }
      }, providerLinks);

      setMessage(t(
        placement === 'next'
          ? 'liveControls.contentAddedNext'
          : 'liveControls.contentAddedEnd',
        { title: item.title }
      ));
    } catch (error) {
      setMessage(t('liveControls.contentAddFailed', {
        code: error instanceof Error ? error.message : 'service_plan_update_failed'
      }));
    } finally {
      setBusy(null);
    }
  }

  async function searchTexts(explicitQuery?: string) {
    const query = (explicitQuery ?? textQuery).trim();
    if (!query || !can('text.search')) return;
    setTextQuery(query);
    const results = await run('text-search', 'text.search', { text: query });
    setTextResults(getTextResults(results));
  }

  async function loadAnnouncements(force = false) {
    if (!can('announcement.read') || busy !== null) return;
    if (announcementsLoaded && !force) return;
    const results = await run('announcement-read', 'announcement.read', {});
    setAnnouncements(getAnnouncementResults(results));
    if (results.some(result => result.accepted)) setAnnouncementsLoaded(true);
  }

  function quickTextProviderId(): string | undefined {
    const candidates = providers.filter(provider =>
      (provider.health === 'online' || provider.health === 'degraded') &&
      provider.capabilities.includes('text.quick.present')
    );
    const routed = controller.nodeState?.routing?.presentation;
    if (routed && candidates.some(provider => provider.providerId === routed)) {
      return routed;
    }
    return candidates.length === 1 ? candidates[0]?.providerId : undefined;
  }

  function savedTextCue(item: SearchTextResult): PreparedProgramCue {
    return {
      id: `text:${item.providerId}:${item.id}`,
      kind: 'text',
      title: item.title,
      subtitle: item.text || t('liveControls.savedText'),
      capability: 'text.present',
      payload: { id: item.id },
      targetProviderIds: [item.providerId]
    };
  }

  function prepareSavedText(item: SearchTextResult) {
    if (!can('text.present')) return;
    setPreparedCue(savedTextCue(item));
  }

  function quickTextCue(): PreparedProgramCue | null {
    const text = quickText.trim();
    if (!text || !can('text.quick.present')) return null;
    const providerId = quickTextProviderId();
    return {
      id: `quick-text:${createClientId()}`,
      kind: 'text',
      title: text.length > 68 ? `${text.slice(0, 65)}…` : text,
      subtitle: t('liveControls.quickText'),
      capability: 'text.quick.present',
      payload: { text },
      targetProviderIds: providerId ? [providerId] : undefined
    };
  }

  function prepareQuickText() {
    const cue = quickTextCue();
    if (cue) setPreparedCue(cue);
  }

  function announcementCue(item: AnnouncementResult): PreparedProgramCue {
    return {
      id: `announcement:${item.providerId}:${item.id}`,
      kind: 'announcement',
      title: item.name,
      subtitle: item.text || t('liveControls.announcement'),
      capability: 'announcement.present',
      payload: { id: item.id },
      targetProviderIds: [item.providerId]
    };
  }

  function prepareAnnouncement(item: AnnouncementResult) {
    if (!can('announcement.present')) return;
    setPreparedCue(announcementCue(item));
  }

  function savedTextServiceItem(item: SearchTextResult): ServiceItem {
    return {
      id: `live-text:${createClientId()}`,
      type: 'text',
      title: item.title,
      state: 'planned',
      payload: {
        source: 'provider-text',
        id: item.id,
        providerId: item.providerId,
        text: item.text
      }
    };
  }

  function quickTextServiceItem(): ServiceItem | null {
    const text = quickText.trim();
    if (!text) return null;
    return {
      id: `live-text:${createClientId()}`,
      type: 'text',
      title: text.length > 56 ? `${text.slice(0, 53)}…` : text,
      state: 'planned',
      payload: {
        source: 'quick-text',
        text,
        providerId: quickTextProviderId()
      }
    };
  }

  function announcementServiceItem(item: AnnouncementResult): ServiceItem {
    return {
      id: `live-announcement:${createClientId()}`,
      type: 'announcement',
      title: item.name,
      state: 'planned',
      payload: {
        source: 'provider-announcement',
        id: item.id,
        providerId: item.providerId,
        name: item.name,
        text: item.text
      }
    };
  }

  function haptic(pattern: number | number[] = 8) {
    try {
      if ('vibrate' in navigator) navigator.vibrate(pattern);
    } catch {
      // Haptics are progressive enhancement only.
    }
  }

  function allowCriticalAction(key: string, windowMs = 450): boolean {
    const now = performance.now();
    const previous = criticalActionAt.current;
    if (previous?.key === key && now - previous.at < windowMs) return false;
    criticalActionAt.current = { key, at: now };
    return true;
  }

  function activateTarget(key: string, prepare: () => void, execute: () => void) {
    const now = performance.now();
    const previous = tapTarget.current;
    if (previous?.key === key && now - previous.at <= 380) {
      tapTarget.current = null;
      haptic(18);
      execute();
      return;
    }
    tapTarget.current = { key, at: now };
    haptic(7);
    prepare();
  }

  async function searchMedia(explicitQuery?: string) {
    if (!can('media.search')) return;
    const query = (explicitQuery ?? mediaQuery).trim();
    setMediaQuery(query);
    const results = await run('media-search', 'media.search', {
      kind: mediaKind,
      filter: query,
      includeMetadata: true,
      includeThumbnail: mediaKind !== 'audio'
    });
    setMediaResults(getMediaResults(results));
  }

  function prepareMedia(item: SearchMediaResult) {
    if (item.isDir || !can('media.open')) return;
    const detail =
      item.width && item.height
        ? `${item.width}×${item.height}`
        : item.durationMs
          ? `${Math.round(item.durationMs / 1000)}s`
          : t(`liveControls.mediaKinds.${mediaKind}`);

    setPreparedCue({
      id: `media:${mediaKind}:${item.name}`,
      kind: 'media',
      title: item.name,
      subtitle: detail,
      capability: 'media.open',
      payload: {
        kind: mediaKind,
        file: item.name
      },
      previewDataUrl: mediaThumbnailUrl(item.thumbnail)
    });
  }

  async function takePreparedCue(cueOverride?: PreparedProgramCue) {
    const cue = cueOverride || preparedCue;
    if (!cue) return;
    if (!allowCriticalAction(`take:${cue.id}`)) return;
    haptic(18);

    const armedVisual = cueCoordinator?.armedVisualCue || null;
    const credential = controller.credential;

    if (cue.liveDropAssetId) {
      setBusy('prepared-take');
      setMessage(null);
      try {
        const response = await controller.openLiveDrop(
          cue.liveDropAssetId,
          {
            actorId,
            liveSessionId,
            providerId: cue.targetProviderIds?.[0],
            serviceItemId: cue.serviceItemId
          }
        );
        const mediaAccepted = response.results.some(result => result.accepted);
        if (!mediaAccepted) {
          const failed = response.results.find(result => !result.accepted);
          setMessage(commandFailure(failed?.errorCode || 'media_open_failed'));
          return;
        }

        let linkedVisualAccepted = true;
        if (armedVisual) {
          const visualResults = await controller.executeCommand({
            capability: 'visual.clip.trigger',
            payload: { clipId: armedVisual.clipId },
            liveSessionId,
            serviceItemId: cue.serviceItemId,
            actorId,
            targetProviderIds: [armedVisual.providerId],
            safetyLevel: 'normal'
          });
          linkedVisualAccepted = visualResults.some(result => result.accepted);
          if (linkedVisualAccepted) cueCoordinator?.clearVisualCue();
        }

        if (!cueOverride || preparedCue?.id === cue.id) setPreparedCue(null);
        setToolMode('media');
        setFollowLive(true);
        if (!linkedVisualAccepted) {
          setMessage(t('liveControls.linkedTakePartial'));
        }
      } catch (error) {
        setMessage(commandFailure(error instanceof Error ? error.message : 'unknown'));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (armedVisual && credential) {
      setBusy('prepared-take');
      setMessage(null);
      try {
        const result = await controller.executeScene({
          liveSessionId,
          serviceItemId: cue.serviceItemId,
          actorId,
          scene: {
            id: createClientId(),
            organizationId: credential.binding.organizationId,
            venueId: credential.binding.venueId,
            liveSystemId: credential.binding.liveSystemId,
            name: `Prepared Take · ${cue.title}`,
            actions: [
              {
                id: 'program-take',
                capability: cue.capability,
                targetProviderIds: cue.targetProviderIds || [],
                outputTargets: ['main'],
                payload: cue.payload,
                safetyLevel: 'normal'
              },
              {
                id: 'visual-take',
                capability: 'visual.clip.trigger',
                targetProviderIds: [armedVisual.providerId],
                outputTargets: ['main'],
                payload: { clipId: armedVisual.clipId },
                safetyLevel: 'normal'
              }
            ]
          }
        });

        const programAccepted = result.actions
          .find(action => action.actionId === 'program-take')
          ?.results.some(item => item.accepted);
        const visualAccepted = result.actions
          .find(action => action.actionId === 'visual-take')
          ?.results.some(item => item.accepted);

        if (programAccepted && (!cueOverride || preparedCue?.id === cue.id)) {
          setPreparedCue(null);
        }
        if (visualAccepted) cueCoordinator?.clearVisualCue();
        if (result.status !== 'completed') {
          setMessage(t('liveControls.linkedTakePartial'));
        }
      } catch (error) {
        setMessage(commandFailure(error instanceof Error ? error.message : 'unknown'));
      } finally {
        setBusy(null);
      }
      return;
    }

    const results = await run(
      'prepared-take',
      cue.capability,
      cue.payload,
      'normal',
      cue.serviceItemId,
      cue.targetProviderIds
    );
    if (
      results.some(result => result.accepted) &&
      (!cueOverride || preparedCue?.id === cue.id)
    ) {
      setPreparedCue(null);
    }
    if (results.some(result => result.accepted)) {
      if (cue.kind === 'song') setToolMode('song');
      if (cue.kind === 'bible') setToolMode('bible');
      if (cue.kind === 'media') setToolMode('media');
      if (cue.kind === 'text' || cue.kind === 'announcement') setToolMode('text');
      setFollowLive(true);
    }
  }

  async function takePrimaryNext() {
    if (preparedSearchHit) {
      await takePreparedSearchHit();
      return;
    }
    if (preparedCue) {
      await takePreparedCue();
      return;
    }
    if (selectedSlideIndex !== null) {
      await goToSlide(selectedSlideIndex);
      return;
    }
    await navigatePresentation('next');
  }

  useEffect(() => {
    universalIndex.seedPrepared(
      servicePlan,
      providerLinks,
      controller.nodeState?.state.scenes || [],
      controller.nodeState?.liveDrop || []
    );
  }, [
    controller.nodeState?.liveDrop,
    controller.nodeState?.state.scenes,
    providerLinks,
    servicePlan,
    universalIndex
  ]);

  useEffect(() => {
    const query = universalQuery.trim();
    if (!query) {
      setLocalSearchHits([]);
      return;
    }
    const kinds =
      universalScope === 'auto'
        ? undefined
        : [universalScope] as Array<'song' | 'bible' | 'media' | 'text'>;
    setLocalSearchHits(universalIndex.search(query, kinds, 8));
  }, [universalIndex, universalQuery, universalScope]);

  function prepareLocalSearchHit(hit: UniversalSearchHit) {
    setPreparedSearchHit(hit);
    haptic(7);
    universalIndex.remember(hit);
  }

  async function takePreparedSearchHit() {
    const hit = preparedSearchHit;
    if (!hit || !allowCriticalAction(`search-take:${hit.id}`)) return;
    haptic(18);
    setBusy('universal-local-take');
    setMessage(null);
    try {
      if (hit.kind === 'scene') {
        const sceneId = String(hit.payload?.sceneId || hit.id.replace(/^scene:/, ''));
        const scene = controller.nodeState?.state.scenes.find(item => item.id === sceneId);
        if (!scene) throw new Error('scene_not_cached');
        await controller.executeScene({
          liveSessionId,
          actorId,
          scene,
          confirmed: true
        });
      } else if (hit.source === 'live-drop') {
        const assetId = String(hit.payload?.assetId || hit.id.replace(/^live-drop:/, ''));
        await controller.openLiveDrop(assetId, { actorId, liveSessionId });
      } else {
        if (!hit.capability || !hit.payload) throw new Error('search_result_not_preparable');
        const results = await controller.executeCommand({
          capability: hit.capability,
          payload: hit.payload,
          liveSessionId,
          actorId,
          serviceItemId: hit.serviceItemId,
          targetProviderIds: hit.targetProviderIds,
          safetyLevel: hit.capability === 'presentation.clear' ? 'guarded' : 'normal',
          confirmed: true
        });
        const failure = results.find(result => !result.accepted);
        if (failure) throw new Error(failure.errorCode || 'provider_error');
      }
      setPreparedSearchHit(null);
      setFollowLive(true);
      await controller.refreshState();
    } catch (error) {
      setMessage(commandFailure(error instanceof Error ? error.message : 'unknown'));
    } finally {
      setBusy(null);
    }
  }

  async function runUniversalSearch() {
    const raw = universalQuery.trim();
    if (!raw || busy !== null) return;

    const localTop = localSearchHits[0];
    if (localTop && localTop.score >= 70) {
      prepareLocalSearchHit(localTop);
      return;
    }

    const prefix = raw.match(/^(b(?:íblia|iblia)?|bible|song|música|musica|media|mídia|midia|text|texto|aviso|announcement)\s*:\s*(.+)$/i);
    const requested = prefix?.[1]?.toLocaleLowerCase();
    const query = (prefix?.[2] || raw).trim();
    const inferredScope =
      universalScope !== 'auto'
        ? universalScope
        : requested?.startsWith('b') || looksLikeBibleReference(query)
          ? 'bible'
          : requested === 'media' || requested === 'mídia' || requested === 'midia'
            ? 'media'
            : requested === 'text' || requested === 'texto' || requested === 'aviso' || requested === 'announcement'
              ? 'text'
              : 'song';

    if (inferredScope === 'bible') {
      openTool('bible');
      setBibleCommand({ text: query, nonce: Date.now() });
      return;
    }
    if (inferredScope === 'media') {
      openTool('media');
      await searchMedia(query);
      return;
    }
    if (inferredScope === 'text') {
      openTool('text');
      setTextQuery(query);
      if (requested === 'aviso' || requested === 'announcement') {
        await loadAnnouncements(true);
      } else if (can('text.search')) {
        await searchTexts(query);
      } else {
        await loadAnnouncements();
      }
      return;
    }
    openTool('song');
    await searchSongs(query);
  }

  async function showStageMessage() {
    const text = stageText.trim();
    if (!text || !can('stage.message')) return;
    await run('stage-message', 'stage.message', {
      text,
      show: true,
      displayAhead: true
    });
  }

  async function hideStageMessage() {
    if (!can('stage.message')) return;
    await run('stage-message-hide', 'stage.message', {
      text: stageText.trim(),
      show: false,
      displayAhead: true
    });
  }

  function requestClear() {
    if (!clearArmed) {
      setClearArmed(true);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    void run('clear', 'presentation.clear', {}, 'guarded', undefined, undefined, true);
  }

  async function syncServicePlaylist() {
    if (!playlistSyncPlan.ready || busy !== null) return;

    if (!playlistSyncArmed) {
      setPlaylistSyncArmed(true);
      setMessage(t('liveControls.playlistSyncReplaceWarning', {
        provider: playlistSyncPlan.providerName || t('liveControls.connectedApp')
      }));
      if (playlistSyncTimer.current) window.clearTimeout(playlistSyncTimer.current);
      playlistSyncTimer.current = window.setTimeout(() => {
        setPlaylistSyncArmed(false);
        setMessage(null);
      }, 6000);
      return;
    }

    setPlaylistSyncArmed(false);
    if (playlistSyncTimer.current) window.clearTimeout(playlistSyncTimer.current);
    const results = await run(
      'playlist-sync',
      'playlist.sync',
      { ids: playlistSyncPlan.ids },
      'guarded',
      undefined,
      [playlistSyncPlan.providerId],
      true
    );
    if (results.length > 0 && results.every(result => result.accepted)) {
      setMessage(t('liveControls.playlistSyncSuccess', {
        provider: playlistSyncPlan.providerName || t('liveControls.connectedApp')
      }));
    }
  }

  const currentPresentationProviderId = providers.find(provider => {
    const candidate = provider.observed?.currentPresentation;
    return candidate && typeof candidate === 'object';
  })?.providerId || null;
  const effectivePresentation =
    samePresentationFrame(previewPresentation, currentPresentation)
      ? previewPresentation
      : currentPresentation;
  const slideNumber = Number(effectivePresentation?.slide_number);
  const totalSlides = Number(effectivePresentation?.total_slides);
  const presentationName =
    String(effectivePresentation?.name || effectivePresentation?.title || '') ||
    t('liveControls.noPresentation');
  const slides = Array.isArray(effectivePresentation?.slides)
    ? effectivePresentation.slides as Array<Record<string, unknown>>
    : [];
  const currentSlideIndex = Number.isFinite(slideNumber) && slideNumber > 0
    ? slideNumber - 1
    : -1;
  const currentSlide = currentSlideIndex >= 0 ? slides[currentSlideIndex] : undefined;
  const nextSlide = currentSlideIndex >= 0 ? slides[currentSlideIndex + 1] : undefined;
  const manuallySelectedSlide = selectedSlideIndex !== null
    ? slides[selectedSlideIndex]
    : undefined;
  const previewSlide = manuallySelectedSlide || nextSlide;
  const currentSlideText = currentSlide?.text ? String(currentSlide.text) : '';
  const previewSlideText = previewSlide?.text ? String(previewSlide.text) : '';
  const currentSlidePreview = slidePreviewUrl(currentSlide);
  const previewSlidePreview = slidePreviewUrl(previewSlide);
  const currentSlideDescription = currentSlide?.slide_description
    ? String(currentSlide.slide_description)
    : '';
  const previewSlideDescription = previewSlide?.slide_description
    ? String(previewSlide.slide_description)
    : '';
  const currentScreenMode = String(
    providers.find(provider => provider.observed?.screenMode)?.observed?.screenMode || 'normal'
  );
  const preparedPrimaryTitle =
    preparedSearchHit?.title ||
    preparedCue?.title ||
    (selectedSlideIndex !== null
      ? t('liveControls.slide', { number: selectedSlideIndex + 1 })
      : '');
  const smartPrimaryMode =
    preparedSearchHit || preparedCue || selectedSlideIndex !== null
      ? 'take'
      : nextSlide && can('presentation.navigation')
        ? 'slide'
        : serviceHorizon.next && buildServiceItemCue(serviceHorizon.next)
          ? 'prepare'
          : 'idle';
  const smartPrimaryTitle =
    smartPrimaryMode === 'take'
      ? preparedPrimaryTitle
      : smartPrimaryMode === 'slide'
        ? (nextSlide?.text ? String(nextSlide.text) : t('liveControls.nextSlide'))
        : smartPrimaryMode === 'prepare'
          ? serviceHorizon.next?.title || ''
          : '';
  const smartPrimaryLabel =
    smartPrimaryMode === 'take'
      ? t('liveControls.smartDock.showNow')
      : smartPrimaryMode === 'slide'
        ? t('liveControls.smartDock.nextSlide')
        : smartPrimaryMode === 'prepare'
          ? t('liveControls.smartDock.prepareNext')
          : t('liveControls.smartDock.waiting');
  const smartPrimaryDisabled =
    busy !== null ||
    smartPrimaryMode === 'idle';

  async function runSmartPrimary() {
    if (smartPrimaryDisabled) return;
    if (smartPrimaryMode === 'prepare') {
      prepareNextServiceItem();
      haptic(7);
      return;
    }
    await takePrimaryNext();
  }
  const presentationFrameSignature = `${String(effectivePresentation?.id || '')}:${currentSlideIndex}`;
  const isSongPresentation = Boolean(
    effectivePresentation?.song_id ||
    /song|music|lyric|lyrics|música|musica|letra/i.test(String(effectivePresentation?.type || ''))
  );
  const songSections = useMemo(
    () => isSongPresentation ? buildSongSections(slides) : [],
    [isSongPresentation, presentationFrameSignature, slides]
  );
  const activeSection = songSections.find(section =>
    currentSlideIndex >= section.startIndex && currentSlideIndex <= section.endIndex
  ) || null;
  const serviceSongs = servicePlan?.items.filter(item => item.type === 'song') || [];
  const visibleAnnouncements = useMemo(() => {
    const query = textQuery.trim().toLocaleLowerCase();
    if (!query) return announcements;
    return announcements.filter(item =>
      item.name.toLocaleLowerCase().includes(query) ||
      item.text?.toLocaleLowerCase().includes(query)
    );
  }, [announcements, textQuery]);

  useEffect(() => {
    if (currentSlideIndex < 0) return;

    if (
      previousFrameSignature.current &&
      previousFrameSignature.current !== presentationFrameSignature
    ) {
      setSelectedSlideIndex(null);
    }
    previousFrameSignature.current = presentationFrameSignature;

    const frame = window.requestAnimationFrame(() => {
      const currentCard = slideRailRef.current?.querySelector<HTMLElement>(
        `[data-slide-index="${currentSlideIndex}"]`
      );
      if (followLive) {
        currentCard?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center'
        });
        const sectionCard = activeSection
          ? sectionRailRef.current?.querySelector<HTMLElement>(
              `[data-section-id="${CSS.escape(activeSection.id)}"]`
            )
          : null;
        sectionCard?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'center'
        });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSection?.id, currentSlideIndex, followLive, presentationFrameSignature]);

  function returnToLive() {
    setSelectedSlideIndex(null);
    setFollowLive(true);
  }

  useLiveOperatorShortcuts({
    enabled: busy === null && !clearArmed,
    bindings: shortcutBindings,
    onPrevious: () => {
      if (can('presentation.navigation')) void navigatePresentation('previous');
    },
    onNext: () => {
      if (can('presentation.navigation')) void navigatePresentation('next');
    },
    onTake: () => {
      void takePrimaryNext();
    }
  });

  function updateShortcut(
    key: keyof LiveShortcutBindings,
    value: string
  ) {
    const next = { ...shortcutBindings, [key]: value };
    // Do not allow one key to invoke more than one live action.
    for (const candidate of Object.keys(next) as Array<keyof LiveShortcutBindings>) {
      if (candidate !== key && value && next[candidate] === value) next[candidate] = '';
    }
    setShortcutBindings(next);
    saveLiveShortcutBindings(next);
  }

  useEffect(() => {
    const handleUniversalShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === 'k'
      ) {
        event.preventDefault();
        universalInputRef.current?.focus();
        universalInputRef.current?.select();
        return;
      }

      if (
        event.key === '/' &&
        !typing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        universalInputRef.current?.focus();
        return;
      }

      if (
        event.key === 'Escape' &&
        document.activeElement === universalInputRef.current
      ) {
        if (universalQuery) {
          event.preventDefault();
          setUniversalQuery('');
        } else {
          universalInputRef.current?.blur();
        }
      }
    };

    window.addEventListener('keydown', handleUniversalShortcut);
    return () => window.removeEventListener('keydown', handleUniversalShortcut);
  }, [universalQuery]);

  return (
    <section className={touchPrimary ? 'live-control-panel touch-primary' : 'live-control-panel'}>
      <div className="live-control-header">
        <div>
          <span className="eyebrow">{t('liveControls.kicker')}</span>
          <h2>{t('liveControls.title')}</h2>
        </div>
        <div className="live-control-header-state">
          {!servicePlanEnabled && (
            <span className="live-free-mode-badge">{t('liveControls.freeMode')}</span>
          )}
          <div className="live-control-health live-system-health">
            <span className={`status ${providers.some(p => p.health === 'online') ? 'ok' : 'warn'}`} />
            <span>
              <strong>
                {providers.some(p => p.health === 'online')
                  ? t('liveControls.systemReady')
                  : t('liveControls.systemAttention')}
              </strong>
              <small>
                {t('liveControls.systemApps', {
                  online: providers.filter(p => p.health === 'online').length,
                  total: providers.length
                })}
                {providers.length
                  ? ` · ${providers.map(provider => provider.displayName).join(', ')}`
                  : ''}
              </small>
            </span>
          </div>
        </div>
      </div>

      <div className="live-universal-bar" role="search">
        <div className="live-universal-input">
          <span aria-hidden="true">⌕</span>
          <input
            ref={universalInputRef}
            value={universalQuery}
            onChange={event => setUniversalQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void runUniversalSearch();
            }}
            placeholder={t('liveControls.universalPlaceholder')}
            aria-label={t('liveControls.universalPlaceholder')}
            aria-keyshortcuts="Control+K Meta+K /"
          />
          <kbd className="universal-shortcut" aria-hidden="true">Ctrl/⌘ K</kbd>
          <button
            type="button"
            disabled={!universalQuery.trim() || busy !== null}
            onClick={() => void runUniversalSearch()}
          >
            {t('liveControls.go')}
          </button>
        </div>
        <div className="live-universal-scopes" aria-label={t('liveControls.searchScope')}>
          {(['auto','song','bible','media','text'] as const).map(scope => (
            <button
              key={scope}
              type="button"
              className={universalScope === scope ? 'active' : ''}
              aria-pressed={universalScope === scope}
              onClick={() => setUniversalScope(scope)}
            >
              {t(`liveControls.searchScopes.${scope}`)}
            </button>
          ))}
        </div>
        <details className="live-shortcut-settings">
          <summary>{t('liveControls.shortcutSettings')}</summary>
          <div className="live-shortcut-grid">
            {([
              ['previous', t('liveControls.shortcutPrevious')],
              ['next', t('liveControls.shortcutNext')],
              ['take', 'TAKE']
            ] as Array<[keyof LiveShortcutBindings, string]>).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <select
                  value={shortcutBindings[key]}
                  onChange={event => updateShortcut(key, event.target.value)}
                >
                  <option value="">{t('liveControls.shortcutNone')}</option>
                  <option value="ArrowLeft">←</option>
                  <option value="ArrowRight">→</option>
                  <option value="PageUp">Page Up</option>
                  <option value="PageDown">Page Down</option>
                  <option value="[">[</option>
                  <option value="]">]</option>
                </select>
              </label>
            ))}
          </div>
          <small>{t('liveControls.shortcutHint')}</small>
        </details>
      </div>

      {localSearchHits.length > 0 && (
        <div className="universal-local-results" aria-label={t('liveControls.localResults')}>
          <div className="universal-local-results-head">
            <strong>{t('liveControls.localResults')}</strong>
            <span>{t('liveControls.localResultsHint')}</span>
          </div>
          {localSearchHits.map(hit => (
            <button
              key={hit.id}
              type="button"
              className={preparedSearchHit?.id === hit.id ? 'prepared' : ''}
              onClick={() => prepareLocalSearchHit(hit)}
            >
              <span>
                <strong>{hit.title}</strong>
                <small>{hit.subtitle || t(`liveControls.localKinds.${hit.kind}`)}</small>
              </span>
              <em>{preparedSearchHit?.id === hit.id
                ? t('liveControls.prepared')
                : t('liveControls.prepare')}</em>
            </button>
          ))}
        </div>
      )}

      {preparedSearchHit && (
        <div className="universal-prepared-next">
          <div>
            <small>{t('liveControls.nextPrepared')}</small>
            <strong>{preparedSearchHit.title}</strong>
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => void takePreparedSearchHit()}
          >
            TAKE
          </button>
        </div>
      )}

      {presentationRouteMissing && (
        <div className="live-route-warning" role="status">
          <div>
            <strong>{t('liveControls.routeRequiredTitle')}</strong>
            <span>{t('liveControls.routeRequiredDescription')}</span>
          </div>
          <em>{presentationProviders.length} {t('liveControls.presentationProviders')}</em>
        </div>
      )}

      <div className="live-control-grid">
        <div className="live-tool-dock" role="tablist" aria-label={t('liveControls.tools')}>
          {(['song','bible','media','text','stage'] as ToolMode[]).map(mode => (
            <button
              key={mode}
              role="tab"
              aria-selected={toolMode === mode}
              className={toolMode === mode ? 'active' : ''}
              disabled={!toolAvailability[mode]}
              onClick={() => openTool(mode)}
            >
              <span>{t(`liveControls.toolTabs.${mode}`)}</span>
              <small>{toolAvailability[mode] ? t('liveControls.available') : t('liveControls.unavailable')}</small>
            </button>
          ))}
        </div>

        <div className="live-follow-row">
          <button
            type="button"
            className={followLive ? 'live-follow-chip active' : 'live-follow-chip'}
            onClick={returnToLive}
          >
            <span />
            {followLive
              ? t('liveControls.followingLive')
              : t('liveControls.returnToLive')}
          </button>
          <small>{t('liveControls.followHint')}</small>
        </div>

        <article className="operator-card program-card">
          <div className="operator-card-head">
            <div>
              <span>{t('liveControls.program')}</span>
              <small className="operator-subtitle">{presentationName}</small>
            </div>
            <div className="program-head-actions">
              {can('presentation.preview') && (
                <button
                  onClick={() => void refreshPresentationPreview()}
                  disabled={busy !== null}
                >
                  {t('liveControls.refreshPreview')}
                </button>
              )}
              {Number.isFinite(slideNumber) && Number.isFinite(totalSlides) && (
                <small>{slideNumber}/{totalSlides}</small>
              )}
            </div>
          </div>

          <div className="now-next-deck" aria-label={t('liveControls.nowNext')}>
            <section className="deck-monitor deck-monitor-live">
              <header>
                <span className="deck-live-dot" />
                <div>
                  <strong>{t('liveControls.currentSlide')}</strong>
                  <small>{t('liveControls.programLabel')}</small>
                </div>
                {currentSlideDescription && <em>{currentSlideDescription}</em>}
              </header>
              <div className="deck-frame">
                {currentSlidePreview ? (
                  <img src={currentSlidePreview} alt={t('liveControls.currentSlide')} />
                ) : (
                  <div className="deck-text-fallback">
                    <small>{String(effectivePresentation?.type || t('liveControls.waiting')).toUpperCase()}</small>
                    <p>{currentSlideText || presentationName}</p>
                  </div>
                )}
              </div>
              <footer>
                <span>{currentSlideText || t('liveControls.noSlideText')}</span>
              </footer>
            </section>

            <div className="deck-flow" aria-hidden="true">
              <span>→</span>
            </div>

            <section className="deck-monitor deck-monitor-next">
              <header>
                <div>
                  <strong>{selectedSlideIndex !== null ? t('liveControls.selectedSlide') : t('liveControls.nextSlide')}</strong>
                  <small>{t('liveControls.previewLabel')}</small>
                </div>
                <div className="deck-next-meta">
                  {preparedCue?.subtitle && <em>{preparedCue.subtitle}</em>}
                  {!preparedCue?.subtitle && previewSlideDescription && <em>{previewSlideDescription}</em>}
                  {cueCoordinator?.armedVisualCue && (
                    <em className="linked-cue-badge">
                      {t('liveControls.visualLinked')} · {cueCoordinator.armedVisualCue.clipName}
                    </em>
                  )}
                  {preparedCue && (
                    <button
                      className="deck-cancel"
                      type="button"
                      onClick={() => setPreparedCue(null)}
                    >
                      {t('liveControls.cancelPrepared')}
                    </button>
                  )}
                </div>
              </header>
              <div className="deck-frame">
                {preparedCue?.previewDataUrl ? (
                  <div className="deck-prepared-media">
                    <img src={preparedCue.previewDataUrl} alt={preparedCue.title} />
                    <div>
                      <small>{t(`liveControls.preparedKinds.${preparedCue.kind}`)}</small>
                      <strong>{preparedCue.title}</strong>
                    </div>
                  </div>
                ) : preparedCue ? (
                  <div className="deck-prepared-cue">
                    <small>{t(`liveControls.preparedKinds.${preparedCue.kind}`)}</small>
                    <strong>{preparedCue.title}</strong>
                    <span>{preparedCue.subtitle || t('liveControls.prepared')}</span>
                  </div>
                ) : previewSlidePreview ? (
                  <img src={previewSlidePreview} alt={t('liveControls.nextSlide')} />
                ) : (
                  <div className="deck-text-fallback">
                    <small>{t('liveControls.upNext')}</small>
                    <p>{previewSlideText || t('liveControls.endOfPresentation')}</p>
                  </div>
                )}
              </div>
              <footer>
                <span>
                  {preparedCue
                    ? t('liveControls.preparedReady')
                    : previewSlideText || t('liveControls.endOfPresentation')}
                </span>
                <button
                  className="deck-take"
                  disabled={
                    busy !== null ||
                    (!preparedCue && (!previewSlide || !can('presentation.navigation')))
                  }
                  onClick={() => void takePrimaryNext()}
                >
                  {busy === 'next' || busy === 'prepared-take'
                    ? '…'
                    : cueCoordinator?.armedVisualCue
                      ? t('liveControls.takeLinked')
                      : preparedCue
                        ? t('liveControls.takePrepared')
                        : t('liveControls.takeNext')} <kbd>→</kbd>
                </button>
              </footer>
            </section>
          </div>

          {songSections.length > 0 && (
            <div className="song-section-shell">
              <div className="song-section-head">
                <div>
                  <strong>{t('liveControls.songSections')}</strong>
                  <span>{t('liveControls.sectionHint')}</span>
                </div>
                {activeSection && (
                  <em>{t('liveControls.currentSection', { section: activeSection.label })}</em>
                )}
              </div>
              <div ref={sectionRailRef} className="song-section-rail">
                {songSections.map(section => {
                  const current = activeSection?.id === section.id;
                  const selected = selectedSlideIndex === section.startIndex && !current;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      data-section-id={section.id}
                      className={[
                        'song-section-chip',
                        current ? 'current' : '',
                        selected ? 'selected' : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => activateTarget(
                        section.id,
                        () => {
                          setSelectedSlideIndex(current ? null : section.startIndex);
                          if (!current) setFollowLive(false);
                        },
                        () => void goToSlide(section.startIndex)
                      )}
                      disabled={busy !== null}
                    >
                      <span>{section.label}</span>
                      <small>
                        {current
                          ? t('liveControls.onAir')
                          : section.startIndex === section.endIndex
                            ? t('liveControls.slide', { number: section.startIndex + 1 })
                            : t('liveControls.slideRange', {
                                start: section.startIndex + 1,
                                end: section.endIndex + 1
                              })}
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {slides.length > 0 && (
            <div className="slide-rail-shell">
              <div className="slide-rail-head">
                <strong>{t('liveControls.slides')}</strong>
                <span>
                  {touchPrimary
                    ? t('liveControls.slideHintTouch')
                    : t('liveControls.slideHint')}
                </span>
              </div>
              <div
                ref={slideRailRef}
                className="slide-rail"
                role="listbox"
                aria-label={t('liveControls.slides')}
              >
                {slides.map((slide, index) => {
                  const thumbnail = slidePreviewUrl(slide);
                  const text = slide?.text ? String(slide.text) : '';
                  const isCurrent = index === currentSlideIndex;
                  const isSelected = index === selectedSlideIndex;
                  return (
                    <button
                      key={`slide-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-slide-index={index}
                      className={[
                        'slide-rail-card',
                        isCurrent ? 'current' : '',
                        isSelected ? 'selected' : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => activateTarget(
                        `slide:${index}`,
                        () => {
                          setSelectedSlideIndex(isCurrent ? null : index);
                          if (!isCurrent) setFollowLive(false);
                        },
                        () => void goToSlide(index)
                      )}
                      disabled={busy !== null}
                    >
                      <span className="slide-rail-number">{index + 1}</span>
                      <div className="slide-rail-preview">
                        {thumbnail ? (
                          <img src={thumbnail} alt="" />
                        ) : (
                          <p>{text || '—'}</p>
                        )}
                      </div>
                      <small>
                        {isCurrent
                          ? t('liveControls.onAir')
                          : isSelected
                            ? t('liveControls.ready')
                            : text || t('liveControls.slide', { number: index + 1 })}
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="live-command-strip">
            <div className="transport-primary" aria-label={t('liveControls.navigation')}>
              <button
                disabled={!can('presentation.navigation') || busy !== null || currentSlideIndex <= 0}
                onClick={() => void goToSlide(0)}
              >
                <kbd>↤</kbd> {t('liveControls.start')}
              </button>
              <button
                disabled={!can('presentation.navigation') || busy !== null}
                onClick={() => void navigatePresentation('previous')}
              >
                <kbd>←</kbd> {t('liveControls.previous')}
              </button>
              <button
                className="next-primary"
                disabled={!can('presentation.navigation') || busy !== null || !nextSlide}
                onClick={() => void navigatePresentation('next')}
              >
                {t('liveControls.next')} <kbd>→</kbd>
              </button>
            </div>
            {can('presentation.screen.mode') && (
              <div className="screen-mode-controls">
                {(['normal','wallpaper','blank','black'] as const).map(mode => (
                  <button
                    key={mode}
                    className={currentScreenMode === mode ? 'active' : ''}
                    disabled={busy !== null}
                    onClick={() => void handleScreenMode(mode)}
                  >
                    {t(`liveControls.screenModes.${mode}`)}
                  </button>
                ))}
              </div>
            )}
            <button
              className={clearArmed ? 'danger-armed' : ''}
              disabled={!can('presentation.clear') || busy !== null}
              onClick={requestClear}
            >
              {clearArmed ? t('liveControls.confirmClear') : t('liveControls.clear')}
            </button>
          </div>

          {backgroundPickerOpen && (
            <section className="background-picker" aria-label={t('liveControls.backgroundTitle')}>
              <header>
                <div>
                  <strong>{t('liveControls.backgroundTitle')}</strong>
                  <span>{t('liveControls.backgroundHint')}</span>
                </div>
                <button type="button" onClick={() => setBackgroundPickerOpen(false)}>
                  {t('liveControls.close')}
                </button>
              </header>

              {canBackgroundRead ? (
                <div className="background-picker-body">
                  <div className="background-library">
                    {backgrounds.map(background => (
                      <button
                        type="button"
                        key={background.id}
                        className={selectedBackground?.id === background.id ? 'selected' : ''}
                        onClick={() => setSelectedBackground(background)}
                        disabled={busy !== null}
                      >
                        <div>
                          {background.thumbnail ? (
                            <img src={background.thumbnail} alt="" />
                          ) : (
                            <span>{background.name.slice(0, 1).toUpperCase()}</span>
                          )}
                        </div>
                        <strong>{background.name}</strong>
                      </button>
                    ))}
                    {!backgrounds.length && busy !== 'background-library' && (
                      <p className="background-empty">{t('liveControls.noBackgrounds')}</p>
                    )}
                  </div>

                  <aside className="background-take-card">
                    {selectedBackground ? (
                      <>
                        <div className="background-selected-preview">
                          {selectedBackground.thumbnail ? (
                            <img src={selectedBackground.thumbnail} alt="" />
                          ) : (
                            <span>{selectedBackground.name}</span>
                          )}
                        </div>
                        <strong>{selectedBackground.name}</strong>
                        <small>{t('liveControls.backgroundSelectionSafe')}</small>
                        <button
                          className="background-take-button"
                          type="button"
                          disabled={!canBackgroundSet || busy !== null}
                          onClick={() => void takeSelectedBackground()}
                        >
                          {t('liveControls.putBackgroundOnAir')}
                        </button>
                      </>
                    ) : (
                      <p>{t('liveControls.chooseBackground')}</p>
                    )}
                  </aside>
                </div>
              ) : (
                <div className="background-safe-fallback">
                  <p>{t('liveControls.backgroundFallback')}</p>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void showCurrentBackgroundFallback()}
                  >
                    {t('liveControls.showCurrentBackground')}
                  </button>
                </div>
              )}
            </section>
          )}
        </article>


        <span ref={serviceSurfaceRef} className="live-service-anchor" aria-hidden="true" />
        {servicePlan && (serviceHorizon.current || serviceHorizon.next) && (
          <div className="service-horizon">
            <div className="service-horizon-label">
              <small>{t('liveControls.serviceHorizon')}</small>
              <strong>{servicePlan.title}</strong>
            </div>
            <div className="service-horizon-item current">
              <small>{t('liveControls.currentItem')}</small>
              <strong>{serviceHorizon.current?.title || t('liveControls.waiting')}</strong>
              <span>{serviceHorizon.current?.type || '—'}</span>
            </div>
            <div className="service-horizon-arrow" aria-hidden="true">→</div>
            <div className={`service-horizon-item next ${preparedCue?.serviceItemId === serviceHorizon.next?.id ? 'prepared' : ''}`}>
              <small>{t('liveControls.nextItem')}</small>
              <strong>{serviceHorizon.next?.title || t('liveControls.endOfService')}</strong>
              <span>
                {preparedCue?.serviceItemId === serviceHorizon.next?.id
                  ? t('liveControls.prepared')
                  : serviceHorizon.next?.type || '—'}
              </span>
            </div>
            <button
              className="service-horizon-take"
              disabled={
                !serviceHorizon.next ||
                !buildServiceItemCue(serviceHorizon.next) ||
                busy !== null
              }
              onClick={prepareNextServiceItem}
            >
              {t('liveControls.prepareItem')} →
            </button>
          </div>
        )}

        {servicePlan?.items.length ? (
          <section className="service-plan-timeline" aria-label={t('liveControls.fullRunOfShow')}>
            <header>
              <div>
                <small>{t('liveControls.fullRunOfShow')}</small>
                <strong>{servicePlan.title}</strong>
              </div>
              <div className="service-plan-head-actions">
                <span>{t('liveControls.runOfShowHint')}</span>
                {playlistSyncPlan.hasSongs && (
                  <button
                    type="button"
                    className={playlistSyncArmed ? 'playlist-sync armed' : 'playlist-sync'}
                    disabled={!playlistSyncPlan.ready || busy !== null}
                    title={!playlistSyncPlan.ready
                      ? t(`liveControls.playlistSyncReasons.${playlistSyncPlan.reason}`)
                      : t('liveControls.playlistSyncHint', {
                          provider: playlistSyncPlan.providerName || t('liveControls.connectedApp')
                        })}
                    onClick={() => void syncServicePlaylist()}
                  >
                    {playlistSyncArmed
                      ? t('liveControls.playlistSyncConfirm')
                      : t('liveControls.playlistSync', {
                          provider: playlistSyncPlan.providerName || t('liveControls.connectedApp')
                        })}
                  </button>
                )}
              </div>
            </header>
            <div className="service-plan-timeline-rail">
              {servicePlan.items.map((item, index) => {
                const cue = buildServiceItemCue(item);
                const isCurrent =
                  item.id === serviceHorizon.current?.id ||
                  item.state === 'live';
                const isPrepared = preparedCue?.serviceItemId === item.id;
                const unavailable = !cue;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      'service-plan-timeline-item',
                      isCurrent ? 'current' : '',
                      isPrepared ? 'prepared' : '',
                      item.state === 'completed' ? 'completed' : '',
                      item.state === 'skipped' ? 'skipped' : '',
                      unavailable ? 'unavailable' : ''
                    ].filter(Boolean).join(' ')}
                    disabled={busy !== null || unavailable}
                    onClick={() => cue && activateTarget(
                      `service-plan:${item.id}`,
                      () => prepareServiceItemCue(item),
                      () => void takePreparedCue(cue)
                    )}
                  >
                    <small>{String(index + 1).padStart(2, '0')}</small>
                    <span>
                      <strong>{item.title}</strong>
                      <em>
                        {t(`liveControls.serviceItemTypes.${item.type}`, {
                          defaultValue: item.type
                        })}
                      </em>
                    </span>
                    <b>
                      {isCurrent
                        ? t('liveControls.onAir')
                        : isPrepared
                          ? t('liveControls.prepared')
                          : unavailable
                            ? t('liveControls.serviceItemNeedsSetup')
                            : t(`liveControls.serviceStates.${item.state}`, {
                                defaultValue: item.state
                              })}
                    </b>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <span ref={toolSurfaceRef} className="live-tool-anchor" aria-hidden="true" />
        {toolMode === 'song' && toolAvailability.song && (
        <article className="operator-card live-tool-card song-library-card">
          <div className="operator-card-head">
            <span>{t('liveControls.song')}</span>
            <small>{t('liveControls.songLibraryHint')}</small>
          </div>
          {serviceSongs.length > 0 && (
            <div className="service-song-library">
              <div className="service-song-library-head">
                <strong>{t('liveControls.serviceSongs')}</strong>
                <span>{t('liveControls.serviceSongsHint')}</span>
              </div>
              <div className="service-song-rail">
                {serviceSongs.map((item, index) => {
                  const isCurrent = item.id === serviceHorizon.current?.id || item.state === 'live';
                  const isPrepared = preparedCue?.serviceItemId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={[
                        'service-song-chip',
                        isCurrent ? 'current' : '',
                        isPrepared ? 'prepared' : ''
                      ].filter(Boolean).join(' ')}
                      onClick={() => activateTarget(
                        `service-song:${item.id}`,
                        () => prepareServiceSong(item),
                        () => void playServiceSong(item)
                      )}
                      disabled={!item.providerLinkId || busy !== null}
                    >
                      <small>{String(index + 1).padStart(2, '0')}</small>
                      <strong>{item.title}</strong>
                      <em>
                        {isCurrent
                          ? t('liveControls.onAir')
                          : isPrepared
                            ? t('liveControls.prepared')
                            : t('liveControls.ready')}
                      </em>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="operator-inline">
            <input
              value={songQuery}
              onChange={event => setSongQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void searchSongs();
              }}
              placeholder={t('liveControls.songPlaceholder')}
              disabled={!can('songs.search')}
            />
            <button
              className="secondary"
              disabled={!songQuery.trim() || !can('songs.search') || busy !== null}
              onClick={() => void searchSongs()}
            >
              {t('liveControls.search')}
            </button>
          </div>
          <div className="provider-search-results">
            {songResults.map(song => {
              const cueId = `song:${song.providerId}:${song.id}`;
              return (
                <div
                  key={`${song.providerId}:${song.id}`}
                  className={preparedCue?.id === cueId ? 'song-search-card prepared' : 'song-search-card'}
                >
                  <button
                    className="song-search-main"
                    disabled={!can('songs.present') || busy !== null}
                    onClick={() => prepareSong(song)}
                  >
                    <span>
                      <strong>{song.title}</strong>
                      <small>
                        {[song.artist, song.key, song.bpm ? `${song.bpm} BPM` : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                    <em>{preparedCue?.id === cueId
                      ? t('liveControls.prepared')
                      : t('liveControls.prepare')}</em>
                  </button>
                  <div className="song-search-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!can('songs.present') || busy !== null}
                      onClick={() => void playSongNow(song)}
                    >
                      {t('liveControls.playNow')}
                    </button>
                    {servicePlan && (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void addSongToService(song, 'next')}
                        >
                          {t('liveControls.addNext')}
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void addSongToService(song, 'end')}
                        >
                          {t('liveControls.addEnd')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {songQuery && !songResults.length && busy !== 'song-search' && (
              <small className="empty-result">{t('liveControls.searchHint')}</small>
            )}
          </div>
        </article>
        )}

        {toolMode === 'bible' && toolAvailability.bible && (
          <BibleWorkspace
            controller={controller}
            actorId={actorId}
            liveSessionId={liveSessionId}
            externalQuery={bibleCommand?.text}
            externalQueryNonce={bibleCommand?.nonce}
            currentPresentationProviderId={currentPresentationProviderId}
            onPresentation={presentation => {
              setPreviewPresentation(presentation);
              setFollowLive(true);
            }}
          />
        )}

        {toolMode === 'media' && toolAvailability.media && (
          <article className="operator-card live-tool-card operator-card-wide">
            <div className="operator-card-head">
              <span>{t('liveControls.media')}</span>
              <div className="operator-segmented">
                {(['video','image','audio'] as const).map(kind => (
                  <button
                    key={kind}
                    className={mediaKind === kind ? 'active' : ''}
                    onClick={() => {
                      setMediaKind(kind);
                      setMediaResults([]);
                    }}
                  >
                    {t(`liveControls.mediaKinds.${kind}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="operator-inline">
              <input
                value={mediaQuery}
                onChange={event => setMediaQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') void searchMedia();
                }}
                placeholder={t('liveControls.mediaPlaceholder')}
              />
              <button
                className="secondary"
                disabled={busy !== null}
                onClick={() => void searchMedia()}
              >
                {t('liveControls.search')}
              </button>
            </div>
            <div className="provider-search-results media-results">
              {mediaResults.map(item => (
                <button
                  key={item.name}
                  disabled={Boolean(item.isDir) || !can('media.open') || busy !== null}
                  className={preparedCue?.id === `media:${mediaKind}:${item.name}` ? 'prepared' : ''}
                  onClick={() => prepareMedia(item)}
                >
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.isDir
                        ? t('liveControls.folder')
                        : item.width && item.height
                          ? `${item.width}×${item.height}`
                          : item.durationMs
                            ? `${Math.round(item.durationMs / 1000)}s`
                            : t('liveControls.mediaReady')}
                    </small>
                  </span>
                  <em>
                    {item.isDir
                      ? '—'
                      : preparedCue?.id === `media:${mediaKind}:${item.name}`
                        ? t('liveControls.prepared')
                        : t('liveControls.prepare')}
                  </em>
                </button>
              ))}
            </div>
          </article>
        )}

        {toolMode === 'text' && toolAvailability.text && (
          <article className="operator-card live-tool-card live-text-card">
            <div className="operator-card-head">
              <div>
                <span>{t('liveControls.textAndAnnouncements')}</span>
                <small>{t('liveControls.textAndAnnouncementsHint')}</small>
              </div>
            </div>

            {can('text.quick.present') && (
              <section className="live-text-section quick">
                <header>
                  <div>
                    <strong>{t('liveControls.quickText')}</strong>
                    <small>{t('liveControls.quickTextHint')}</small>
                  </div>
                </header>
                <textarea
                  className="operator-textarea"
                  value={quickText}
                  onChange={event => setQuickText(event.target.value)}
                  placeholder={t('liveControls.quickTextPlaceholder')}
                  rows={3}
                />
                <div className="live-text-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!quickText.trim() || busy !== null}
                    onClick={prepareQuickText}
                  >
                    {t('liveControls.prepare')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!quickText.trim() || busy !== null}
                    onClick={() => {
                      const cue = quickTextCue();
                      if (cue) void takePreparedCue(cue);
                    }}
                  >
                    {t('liveControls.takePrepared')}
                  </button>
                  {servicePlan && (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!quickText.trim() || busy !== null}
                        onClick={() => {
                          const item = quickTextServiceItem();
                          if (item) void addOperatorItemToService(item, 'next');
                        }}
                      >
                        {t('liveControls.addNext')}
                      </button>
                      <button
                        type="button"
                        className="ghost-action"
                        disabled={!quickText.trim() || busy !== null}
                        onClick={() => {
                          const item = quickTextServiceItem();
                          if (item) void addOperatorItemToService(item, 'end');
                        }}
                      >
                        {t('liveControls.addEnd')}
                      </button>
                    </>
                  )}
                </div>
              </section>
            )}

            {can('text.search') && (
              <section className="live-text-section">
                <header>
                  <div>
                    <strong>{t('liveControls.savedTexts')}</strong>
                    <small>{t('liveControls.savedTextsHint')}</small>
                  </div>
                </header>
                <div className="operator-inline">
                  <input
                    value={textQuery}
                    onChange={event => setTextQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void searchTexts();
                    }}
                    placeholder={t('liveControls.textPlaceholder')}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!textQuery.trim() || busy !== null}
                    onClick={() => void searchTexts()}
                  >
                    {t('liveControls.search')}
                  </button>
                </div>

                <div className="live-text-results">
                  {textResults.map(item => {
                    const cue = savedTextCue(item);
                    const prepared = preparedCue?.id === cue.id;
                    return (
                      <div
                        key={cue.id}
                        className={prepared ? 'live-text-result prepared' : 'live-text-result'}
                      >
                        <button
                          type="button"
                          className="live-text-result-main"
                          disabled={!can('text.present') || busy !== null}
                          onClick={() => activateTarget(
                            cue.id,
                            () => prepareSavedText(item),
                            () => void takePreparedCue(cue)
                          )}
                        >
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.text || t('liveControls.savedText')}</small>
                          </span>
                          <em>{prepared ? t('liveControls.prepared') : t('liveControls.prepare')}</em>
                        </button>
                        {servicePlan && (
                          <div className="live-text-result-actions">
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void addOperatorItemToService(
                                savedTextServiceItem(item),
                                'next'
                              )}
                            >
                              {t('liveControls.addNext')}
                            </button>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void addOperatorItemToService(
                                savedTextServiceItem(item),
                                'end'
                              )}
                            >
                              {t('liveControls.addEnd')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!textResults.length && textQuery.trim() && busy !== 'text-search' && (
                    <div className="live-text-empty">{t('liveControls.noSavedTextsFound')}</div>
                  )}
                </div>
              </section>
            )}

            {can('announcement.read') && (
              <section className="live-text-section announcements">
                <header>
                  <div>
                    <strong>{t('liveControls.announcements')}</strong>
                    <small>{t('liveControls.announcementsHint')}</small>
                  </div>
                  <button
                    type="button"
                    className="ghost-action"
                    disabled={busy !== null}
                    onClick={() => void loadAnnouncements(true)}
                  >
                    {t('liveControls.refreshAnnouncements')}
                  </button>
                </header>

                <div className="live-announcement-grid">
                  {visibleAnnouncements.map(item => {
                    const cue = announcementCue(item);
                    const prepared = preparedCue?.id === cue.id;
                    return (
                      <div
                        key={cue.id}
                        className={prepared ? 'live-announcement-card prepared' : 'live-announcement-card'}
                      >
                        <button
                          type="button"
                          className="live-announcement-main"
                          disabled={!can('announcement.present') || busy !== null}
                          onClick={() => activateTarget(
                            cue.id,
                            () => prepareAnnouncement(item),
                            () => void takePreparedCue(cue)
                          )}
                        >
                          <strong>{item.name}</strong>
                          <span>{item.text || t('liveControls.announcementReady')}</span>
                          <em>{prepared ? t('liveControls.prepared') : t('liveControls.prepare')}</em>
                        </button>
                        {servicePlan && (
                          <div className="live-text-result-actions">
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void addOperatorItemToService(
                                announcementServiceItem(item),
                                'next'
                              )}
                            >
                              {t('liveControls.addNext')}
                            </button>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void addOperatorItemToService(
                                announcementServiceItem(item),
                                'end'
                              )}
                            >
                              {t('liveControls.addEnd')}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {!visibleAnnouncements.length && announcementsLoaded && (
                  <div className="live-text-empty">{t('liveControls.noAnnouncements')}</div>
                )}
              </section>
            )}
          </article>
        )}

        {toolMode === 'stage' && toolAvailability.stage && (
          <article className="operator-card live-tool-card">
            <div className="operator-card-head"><span>{t('liveControls.stage')}</span></div>
            <textarea
              className="operator-textarea"
              value={stageText}
              onChange={event => setStageText(event.target.value)}
              placeholder={t('liveControls.stagePlaceholder')}
              rows={4}
            />
            <div className="operator-dual-actions">
              <button
                className="secondary"
                disabled={!stageText.trim() || busy !== null}
                onClick={() => void showStageMessage()}
              >
                {t('liveControls.showStage')}
              </button>
              <button
                className="ghost-action"
                disabled={busy !== null}
                onClick={() => void hideStageMessage()}
              >
                {t('liveControls.hideStage')}
              </button>
            </div>
          </article>
        )}

      </div>

      {message && <div className="operator-message">{message}</div>}
      {touchPrimary && (
        <nav className="live-smart-dock" aria-label={t('liveControls.smartDock.ariaLabel')}>
          <button
            type="button"
            className="live-smart-dock-shortcut"
            onClick={focusUniversalSearch}
          >
            <span aria-hidden="true">⌕</span>
            <small>{t('liveControls.smartDock.search')}</small>
          </button>
          <button
            type="button"
            className={toolMode === 'bible' ? 'live-smart-dock-shortcut active' : 'live-smart-dock-shortcut'}
            disabled={!toolAvailability.bible}
            onClick={() => openTool('bible')}
          >
            <span aria-hidden="true">B</span>
            <small>{t('liveControls.smartDock.bible')}</small>
          </button>
          <button
            type="button"
            className="live-smart-dock-shortcut"
            disabled={!servicePlan}
            onClick={openServiceHorizon}
          >
            <span aria-hidden="true">≡</span>
            <small>{t('liveControls.smartDock.runOfShow')}</small>
          </button>
          <button
            type="button"
            className={`live-smart-dock-primary mode-${smartPrimaryMode}`}
            disabled={smartPrimaryDisabled}
            onClick={() => void runSmartPrimary()}
          >
            <span>
              <small>{smartPrimaryLabel}</small>
              <strong>{smartPrimaryTitle || t('liveControls.smartDock.noAction')}</strong>
            </span>
            <b aria-hidden="true">{smartPrimaryMode === 'prepare' ? '+' : '→'}</b>
          </button>
        </nav>
      )}
    </section>
  );
}
