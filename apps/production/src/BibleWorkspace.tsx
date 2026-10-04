import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandResult } from '@millionsnest/nestlive-production-domain';
import type { useLiveNode } from './useLiveNode';

type Controller = ReturnType<typeof useLiveNode>;

interface BibleVerseReference {
  id: string;
  book?: number;
  chapter?: number;
  verse?: number;
  reference: string;
  text?: string;
}

interface BibleReferenceMatch {
  reference: string;
  ids: string[];
  verses: BibleVerseReference[];
}

interface BibleVersion {
  key: string;
  version: string;
  title: string;
  languageId?: string;
  languageIso?: string;
}

interface BibleBook {
  id: string;
  name: string;
  abbrev: string;
  usfxCode?: string;
}

interface SavedBibleReference extends BibleReferenceMatch {
  version?: string;
  savedAt: string;
}

interface ParsedReference {
  bookLabel: string;
  book?: number;
  chapter: number;
  verse?: number;
}

interface ChapterSnapshot {
  context: ParsedReference;
  verses: BibleVerseReference[];
}

interface PreviousSong {
  providerId: string;
  songId: string;
  title: string;
  slideIndex: number;
}

function optionalText(item: Record<string, unknown>): string | undefined {
  for (const key of ['text', 'content', 'verse_text', 'verseText', 'value']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeMatch(value: unknown): BibleReferenceMatch | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const ids = Array.isArray(item.ids)
    ? item.ids.map(String).filter(Boolean)
    : item.id
      ? [String(item.id)]
      : [];
  const verses = Array.isArray(item.verses)
    ? item.verses
        .filter(candidate => candidate && typeof candidate === 'object')
        .map(candidate => {
          const verse = candidate as Record<string, unknown>;
          return {
            id: String(verse.id || ''),
            book: typeof verse.book === 'number' ? verse.book : undefined,
            chapter: typeof verse.chapter === 'number' ? verse.chapter : undefined,
            verse: typeof verse.verse === 'number' ? verse.verse : undefined,
            reference: String(verse.reference || ''),
            text: optionalText(verse)
          };
        })
        .filter(verse => verse.id || verse.reference)
    : [];

  if (!verses.length && (item.id || item.reference)) {
    verses.push({
      id: String(item.id || ''),
      book: typeof item.book === 'number' ? item.book : undefined,
      chapter: typeof item.chapter === 'number' ? item.chapter : undefined,
      verse: typeof item.verse === 'number' ? item.verse : undefined,
      reference: String(item.reference || ''),
      text: optionalText(item)
    });
  }

  const reference = String(
    item.reference ||
    verses.map(verse => verse.reference).filter(Boolean).join(', ') ||
    ids[0] ||
    ''
  ).trim();
  if (!reference && ids.length === 0) return null;
  return { reference, ids, verses };
}

function getBibleMatches(results: CommandResult[]): BibleReferenceMatch[] {
  const normalized: BibleReferenceMatch[] = [];
  for (const result of results) {
    const raw = result.observedState?.matches;
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const value of values) {
      const match = normalizeMatch(value);
      if (match) normalized.push(match);
    }
  }

  const seen = new Set<string>();
  return normalized.filter(match => {
    const key = match.ids.join('|') || match.reference.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getBibleVersions(results: CommandResult[]): BibleVersion[] {
  const values = results.flatMap(result => {
    const raw = result.observedState?.versions;
    return Array.isArray(raw) ? raw : [];
  });

  const versions = values
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      const language = item.language && typeof item.language === 'object'
        ? item.language as Record<string, unknown>
        : {};
      const key = String(item.key || item.version || '');
      const version = String(item.version || item.key || '');
      return {
        key,
        version,
        title: String(item.title || version || key),
        languageId: language.id ? String(language.id) : undefined,
        languageIso: language.iso ? String(language.iso) : undefined
      };
    })
    .filter(item => item.key && item.version);

  const seen = new Set<string>();
  return versions.filter(item => {
    const key = `${item.key}:${item.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getBibleBooks(results: CommandResult[]): BibleBook[] {
  const values = results.flatMap(result => {
    const raw = result.observedState?.books;
    return Array.isArray(raw) ? raw : [];
  });

  const books = values
    .filter(value => value && typeof value === 'object')
    .map(value => {
      const item = value as Record<string, unknown>;
      return {
        id: String(item.id || ''),
        name: String(item.name || item.abbrev || ''),
        abbrev: String(item.abbrev || item.name || ''),
        usfxCode: item.usfx_code ? String(item.usfx_code) : undefined
      };
    })
    .filter(item => item.id && item.name);

  const seen = new Set<string>();
  return books.filter(book => {
    const key = book.id || book.name.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function presentationFromResults(results: CommandResult[]): Record<string, unknown> | null {
  for (const result of results) {
    const presentation = result.observedState?.currentPresentation;
    if (presentation && typeof presentation === 'object') {
      return presentation as Record<string, unknown>;
    }
  }
  return null;
}

function parseReference(value: string): ParsedReference | null {
  const normalized = value
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(
    /^((?:[1-3]\s*)?[\p{L}.ªº]+(?:\s+[\p{L}.ªº]+)*)\s+(\d+)(?:(?:\s*[:.]\s*|\s+)(\d+))?/iu
  );
  if (!match) return null;
  const chapter = Number(match[2]);
  const verse = match[3] ? Number(match[3]) : undefined;
  if (!Number.isFinite(chapter) || chapter <= 0) return null;
  return {
    bookLabel: match[1]!.trim(),
    chapter,
    verse: verse && Number.isFinite(verse) ? verse : undefined
  };
}

const BIBLE_CHAPTER_COUNTS = [
  50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10,
  42, 150, 31, 12, 8, 66, 52, 5, 48, 12, 14, 3, 9, 1, 4, 7, 3, 3, 3, 2,
  14, 4, 28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1,
  13, 5, 5, 3, 5, 1, 1, 1, 22
] as const;

function normalizeBibleLookup(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function findBibleBook(books: BibleBook[], value: string): BibleBook | undefined {
  const query = normalizeBibleLookup(value);
  if (!query) return undefined;
  return books.find(book =>
    normalizeBibleLookup(book.name) === query ||
    normalizeBibleLookup(book.abbrev) === query
  ) || books.find(book =>
    normalizeBibleLookup(book.name).startsWith(query) ||
    normalizeBibleLookup(book.abbrev).startsWith(query)
  );
}

function chapterCountForBook(book: BibleBook | undefined): number {
  if (!book) return 0;
  const id = Number.parseInt(book.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > BIBLE_CHAPTER_COUNTS.length) return 0;
  return BIBLE_CHAPTER_COUNTS[id - 1] || 0;
}

function bibleBookGroup(book: BibleBook): string {
  const id = Number.parseInt(book.id, 10);
  if (id <= 5) return 'law';
  if (id <= 17) return 'history';
  if (id <= 22) return 'wisdom';
  if (id <= 39) return 'prophets';
  if (id <= 44) return 'gospels';
  if (id <= 65) return 'letters';
  return 'revelation';
}

function flattenVerses(matches: BibleReferenceMatch[]): BibleVerseReference[] {
  const verses = matches.flatMap(match =>
    match.verses.length
      ? match.verses
      : [{
          id: match.ids[0] || '',
          reference: match.reference
        }]
  );
  const seen = new Set<string>();
  return verses.filter(verse => {
    const key = verse.id || verse.reference.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function verseAsMatch(verse: BibleVerseReference): BibleReferenceMatch {
  return {
    reference: verse.reference,
    ids: verse.id ? [verse.id] : [],
    verses: [verse]
  };
}

function sameChapter(a: ParsedReference | null | undefined, b: ParsedReference | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.book && b.book) return a.book === b.book && a.chapter === b.chapter;
  return (
    a.bookLabel.toLocaleLowerCase() === b.bookLabel.toLocaleLowerCase() &&
    a.chapter === b.chapter
  );
}

function verseIdentity(verse: BibleVerseReference): string {
  return verse.id || verse.reference.toLocaleLowerCase();
}

function canonicalContext(
  requested: ParsedReference,
  verses: BibleVerseReference[]
): ParsedReference {
  const first = verses[0];
  const parsed = first ? parseReference(first.reference) : null;
  return {
    bookLabel: parsed?.bookLabel || requested.bookLabel,
    book: first?.book || requested.book,
    chapter: first?.chapter || parsed?.chapter || requested.chapter,
    verse: requested.verse
  };
}

function readStoredReferences(key: string): SavedBibleReference[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item === 'object' && typeof item.reference === 'string')
      .slice(0, 50) as SavedBibleReference[];
  } catch {
    return [];
  }
}

function writeStoredReferences(key: string, value: SavedBibleReference[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value.slice(0, 50)));
  } catch {
    // Local operation must keep working even when storage is unavailable.
  }
}

function savedKey(item: Pick<BibleReferenceMatch, 'reference' | 'ids'>): string {
  return item.ids.join('|') || item.reference.trim().toLocaleLowerCase();
}

function slideText(slide: Record<string, unknown> | undefined): string {
  if (!slide) return '';
  for (const key of ['text', 'content', 'value']) {
    const value = slide[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function slideReference(
  slide: Record<string, unknown> | undefined,
  presentation: Record<string, unknown> | null
): string {
  if (slide) {
    for (const key of ['slide_description', 'description', 'reference']) {
      const value = slide[key];
      if (typeof value === 'string' && parseReference(value)) return value.trim();
    }
  }
  const name = String(presentation?.name || presentation?.title || '').trim();
  return parseReference(name) ? name : '';
}

export function BibleWorkspace({
  controller,
  actorId,
  liveSessionId,
  externalQuery,
  externalQueryNonce,
  currentPresentationProviderId,
  onPresentation
}: {
  controller: Controller;
  actorId: string;
  liveSessionId: string;
  externalQuery?: string;
  externalQueryNonce?: number;
  currentPresentationProviderId?: string | null;
  onPresentation?: (presentation: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BibleReferenceMatch[]>([]);
  const [selected, setSelected] = useState<BibleReferenceMatch | null>(null);
  const [versions, setVersions] = useState<BibleVersion[]>([]);
  const [version, setVersion] = useState('');
  const [books, setBooks] = useState<BibleBook[]>([]);
  const [booksLoading, setBooksLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBookId, setPickerBookId] = useState('');
  const [pickerChapter, setPickerChapter] = useState('1');
  const [favorites, setFavorites] = useState<SavedBibleReference[]>([]);
  const [history, setHistory] = useState<SavedBibleReference[]>([]);
  const [view, setView] = useState<'search' | 'favorites' | 'history'>('search');
  const [busy, setBusy] = useState<'search' | 'chapter' | 'take' | 'return' | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [chapterContext, setChapterContext] = useState<ParsedReference | null>(null);
  const [chapterVerses, setChapterVerses] = useState<BibleVerseReference[]>([]);
  const [multiSelect, setMultiSelect] = useState(false);
  const [multiKeys, setMultiKeys] = useState<Set<string>>(() => new Set());
  const [previousSong, setPreviousSong] = useState<PreviousSong | null>(null);
  const [chapterCacheEpoch, setChapterCacheEpoch] = useState(0);
  const versionsLoadStarted = useRef(false);
  const chapterCache = useRef(new Map<string, ChapterSnapshot>());
  const chapterRequests = useRef(new Map<string, Promise<ChapterSnapshot>>());
  const verseListRef = useRef<HTMLDivElement | null>(null);
  const smartRailRef = useRef<HTMLDivElement | null>(null);
  const previousLiveVerseId = useRef('');
  const tapTarget = useRef<{ key: string; at: number } | null>(null);

  const providers = controller.nodeState?.providers || [];
  const capabilitySet = useMemo(
    () => new Set(
      providers
        .filter(provider => provider.health === 'online' || provider.health === 'degraded')
        .flatMap(provider => provider.capabilities)
    ),
    [providers]
  );
  const canSearch = capabilitySet.has('bible.search');
  const canPresent = capabilitySet.has('bible.present');
  const canReadVersions = capabilitySet.has('bible.versions.read');
  const canReadBooks = capabilitySet.has('bible.books.read');

  const livePresentationEntry = useMemo(() => {
    for (const provider of providers) {
      const presentation = provider.observed?.currentPresentation;
      if (presentation && typeof presentation === 'object') {
        return {
          providerId: provider.providerId,
          presentation: presentation as Record<string, unknown>
        };
      }
    }
    return null;
  }, [providers]);

  const livePresentation = livePresentationEntry?.presentation || null;
  const liveSlides = Array.isArray(livePresentation?.slides)
    ? livePresentation.slides as Array<Record<string, unknown>>
    : [];
  const liveSlideNumber = Number(livePresentation?.slide_number);
  const liveSlideIndex = Number.isFinite(liveSlideNumber) && liveSlideNumber > 0
    ? liveSlideNumber - 1
    : 0;
  const liveSlide = liveSlides[liveSlideIndex];
  const liveType = String(livePresentation?.type || livePresentation?.slide_type || '');
  const providerSaysBibleIsLive = /bible|verse|bíblia|biblia/i.test(liveType);
  const liveVerseId = providerSaysBibleIsLive
    ? String(livePresentation?.id || '')
    : '';
  const cachedLiveVerse = liveVerseId
    ? Array.from(chapterCache.current.values())
        .flatMap(snapshot => snapshot.verses)
        .find(verse => verse.id === liveVerseId)
    : undefined;
  const liveReference =
    slideReference(liveSlide, livePresentation) ||
    cachedLiveVerse?.reference ||
    '';
  const liveParsed = parseReference(liveReference);
  const isBibleLive = Boolean(liveParsed || liveVerseId || providerSaysBibleIsLive);
  const liveVerseText = isBibleLive
    ? slideText(liveSlide) || cachedLiveVerse?.text || ''
    : '';

  const binding = controller.credential?.binding;
  const storageScope = binding
    ? `${binding.organizationId}:${binding.venueId}`
    : 'local';
  const favoritesKey = `nestlive:bible:favorites:${storageScope}`;
  const historyKey = `nestlive:bible:history:${storageScope}`;

  useEffect(() => {
    setFavorites(readStoredReferences(favoritesKey));
    setHistory(readStoredReferences(historyKey));
  }, [favoritesKey, historyKey]);

  useEffect(() => {
    if (!canReadVersions || versionsLoadStarted.current) return;
    versionsLoadStarted.current = true;
    let cancelled = false;
    setVersionsLoading(true);
    void controller.executeCommand({
      capability: 'bible.versions.read',
      payload: {},
      liveSessionId,
      actorId,
      safetyLevel: 'normal'
    }).then(response => {
      if (cancelled) return;
      setVersions(getBibleVersions(response));
    }).catch(() => {
      // Version selection is progressive enhancement; the provider default remains usable.
    }).finally(() => {
      if (!cancelled) setVersionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [actorId, canReadVersions, controller.executeCommand, liveSessionId]);

  useEffect(() => {
    if (!chapterContext || !canSearch) return;
    // Version/language changes invalidate only the navigation cache. Rebuild from
    // Holyrics so book labels and verse IDs always match the provider context.
    void loadChapter(chapterContext, { background: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const favoriteKeys = useMemo(
    () => new Set(favorites.map(item => savedKey(item))),
    [favorites]
  );
  const selectedVersion = useMemo(
    () => versions.find(item => item.key === version || item.version === version),
    [version, versions]
  );
  const bibleLanguageId =
    selectedVersion?.languageId ||
    versions.find(item => item.languageId)?.languageId;

  useEffect(() => {
    if (!canReadBooks || !bibleLanguageId) {
      setBooks([]);
      return;
    }

    let cancelled = false;
    setBooksLoading(true);
    void controller.executeCommand({
      capability: 'bible.books.read',
      payload: { languageId: bibleLanguageId },
      liveSessionId,
      actorId,
      safetyLevel: 'normal'
    }).then(response => {
      if (cancelled) return;
      const nextBooks = getBibleBooks(response);
      setBooks(nextBooks);
      setPickerBookId(current => current || nextBooks[0]?.id || '');
    }).catch(() => {
      if (!cancelled) setBooks([]);
    }).finally(() => {
      if (!cancelled) setBooksLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    actorId,
    bibleLanguageId,
    canReadBooks,
    controller.executeCommand,
    liveSessionId
  ]);

  function chapterSignature(reference: ParsedReference): string {
    return [
      reference.bookLabel.toLocaleLowerCase(),
      reference.chapter,
      bibleLanguageId || 'provider-default'
    ].join(':');
  }

  async function requestChapter(reference: ParsedReference): Promise<ChapterSnapshot> {
    const signature = chapterSignature(reference);
    const cached = chapterCache.current.get(signature);
    if (cached) return cached;

    const pending = chapterRequests.current.get(signature);
    if (pending) return pending;

    const request = (async () => {
      const response = await controller.executeCommand({
        capability: 'bible.search',
        payload: {
          text: `${reference.bookLabel} ${reference.chapter}`,
          languageId: bibleLanguageId
        },
        liveSessionId,
        actorId,
        safetyLevel: 'normal'
      });
      const failed = response.find(result => !result.accepted);
      if (failed) {
        throw new Error(failed.errorCode || 'provider_error');
      }

      const matches = getBibleMatches(response);
      let verses = flattenVerses(matches);

      // Holyrics does not expose arbitrary Bible text through this command.
      // Only enrich with text that was actually observed in the current provider presentation.
      if (
        isBibleLive &&
        liveParsed &&
        sameChapter(liveParsed, reference) &&
        liveSlides.length
      ) {
        const observed = liveSlides.map((slide, index) => {
          const ref = slideReference(slide, livePresentation) ||
            `${reference.bookLabel} ${reference.chapter}:${index + 1}`;
          return {
            id: '',
            reference: ref,
            text: slideText(slide)
          } satisfies BibleVerseReference;
        });
        const byReference = new Map(
          observed.map(item => [item.reference.toLocaleLowerCase(), item])
        );
        verses = verses.map(verse => ({
          ...verse,
          text: verse.text || byReference.get(verse.reference.toLocaleLowerCase())?.text
        }));
        if (!verses.length) verses = observed;
      }

      const snapshot: ChapterSnapshot = {
        context: canonicalContext(reference, verses),
        verses
      };
      chapterCache.current.set(signature, snapshot);
      const canonicalSignature = chapterSignature(snapshot.context);
      chapterCache.current.set(canonicalSignature, snapshot);
      setChapterCacheEpoch(current => current + 1);
      return snapshot;
    })().finally(() => {
      chapterRequests.current.delete(signature);
    });

    chapterRequests.current.set(signature, request);
    return request;
  }

  function bookForContext(context: ParsedReference | null | undefined): BibleBook | undefined {
    if (!context) return undefined;
    if (context.book) {
      const byId = books.find(book => Number(book.id) === context.book);
      if (byId) return byId;
    }
    const label = context.bookLabel.toLocaleLowerCase();
    return books.find(book =>
      book.name.toLocaleLowerCase() === label ||
      book.abbrev.toLocaleLowerCase() === label
    );
  }

  function contextForBook(book: BibleBook, chapter: number): ParsedReference {
    return {
      bookLabel: book.name || book.abbrev,
      book: Number(book.id) || undefined,
      chapter
    };
  }

  async function lastChapterForBook(book: BibleBook): Promise<ChapterSnapshot | null> {
    // Discover the provider's actual final chapter instead of maintaining a
    // hard-coded Bible chapter-count table in NestLive.
    let low = 1;
    let high = 2;
    let lowSnapshot = await requestChapter(contextForBook(book, low));
    if (!lowSnapshot.verses.length) return null;

    while (high <= 512) {
      const snapshot = await requestChapter(contextForBook(book, high));
      if (!snapshot.verses.length) break;
      low = high;
      lowSnapshot = snapshot;
      high *= 2;
    }

    let best = lowSnapshot;
    let left = low + 1;
    let right = Math.min(high - 1, 511);
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const snapshot = await requestChapter(contextForBook(book, mid));
      if (snapshot.verses.length) {
        best = snapshot;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return best;
  }

  async function chapterAcrossBookBoundary(
    context: ParsedReference,
    delta: -1 | 1
  ): Promise<ChapterSnapshot | null> {
    if (!books.length) return null;
    const currentBook = bookForContext(context);
    if (!currentBook) return null;
    const index = books.findIndex(book => book.id === currentBook.id);
    if (index < 0) return null;
    const adjacentBook = books[index + delta];
    if (!adjacentBook) return null;
    if (delta > 0) {
      const snapshot = await requestChapter(contextForBook(adjacentBook, 1));
      return snapshot.verses.length ? snapshot : null;
    }
    return lastChapterForBook(adjacentBook);
  }

  async function prefetchAdjacentChapters(context: ParsedReference) {
    if (!canSearch) return;
    const jobs: Promise<ChapterSnapshot>[] = [];
    if (context.chapter > 1) {
      jobs.push(requestChapter({
        ...context,
        chapter: context.chapter - 1,
        verse: undefined
      }));
    }
    jobs.push(requestChapter({
      ...context,
      chapter: context.chapter + 1,
      verse: undefined
    }));
    const settled = await Promise.allSettled(jobs);

    // At the end of a book, prepare the first real chapter of the next book
    // from the provider's own book list. Never fabricate a cross-book reference.
    const nextResult = settled[settled.length - 1];
    if (
      nextResult?.status === 'fulfilled' &&
      !nextResult.value.verses.length
    ) {
      const nextBook = await chapterAcrossBookBoundary(context, 1);
      if (nextBook?.verses.length) {
        chapterCache.current.set(chapterSignature(nextBook.context), nextBook);
      }
    }
  }

  function saveHistory(match: BibleReferenceMatch) {
    const entry: SavedBibleReference = {
      ...match,
      version: version || undefined,
      savedAt: new Date().toISOString()
    };
    setHistory(current => {
      const key = savedKey(entry);
      const next = [entry, ...current.filter(item => savedKey(item) !== key)].slice(0, 40);
      writeStoredReferences(historyKey, next);
      return next;
    });
  }

  function toggleFavorite(match: BibleReferenceMatch) {
    const key = savedKey(match);
    setFavorites(current => {
      const exists = current.some(item => savedKey(item) === key);
      const next = exists
        ? current.filter(item => savedKey(item) !== key)
        : [{
            ...match,
            version: version || undefined,
            savedAt: new Date().toISOString()
          }, ...current].slice(0, 30);
      writeStoredReferences(favoritesKey, next);
      return next;
    });
  }

  async function performSearch(textInput: string, selectFirst = true) {
    const text = textInput.trim();
    if (!text || busy) return [] as BibleReferenceMatch[];
    setBusy('search');
    setMessage(null);
    try {
      if (!canSearch) {
        const direct = { reference: text, ids: [], verses: [] };
        setResults([direct]);
        if (selectFirst) setSelected(direct);
        return [direct];
      }

      const response = await controller.executeCommand({
        capability: 'bible.search',
        payload: {
          text,
          languageId: bibleLanguageId
        },
        liveSessionId,
        actorId,
        safetyLevel: 'normal'
      });
      const failed = response.find(result => !result.accepted);
      if (failed) {
        setMessage(t('bibleWorkspace.errors.search', {
          code: failed.errorCode || 'provider_error'
        }));
        return [];
      }

      const matches = getBibleMatches(response);
      setResults(matches);
      if (selectFirst) setSelected(matches[0] || null);
      if (!matches.length) setMessage(t('bibleWorkspace.notFound'));
      return matches;
    } catch (error) {
      setMessage(t('bibleWorkspace.errors.search', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
      return [];
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    const text = query.trim();
    if (!text) return;
    setView('search');

    const directReference = parseReference(text);
    const matchingBook = directReference ? undefined : findBibleBook(books, text);
    if (matchingBook) {
      setPickerOpen(true);
      setPickerBookId(matchingBook.id);
      setPickerChapter('1');
      setResults([]);
      setSelected(null);
      setMessage(null);
      return;
    }

    const matches = await performSearch(text);
    const parsed = parseReference(matches[0]?.reference || text);
    if (parsed) void loadChapter(parsed);
  }

  async function loadChapter(
    reference: ParsedReference,
    options: { background?: boolean } = {}
  ): Promise<ChapterSnapshot | null> {
    if (!canSearch) {
      setChapterContext(reference);
      return null;
    }

    const ownsBusyState = !options.background && busy === null;
    if (ownsBusyState) {
      setBusy('chapter');
      setMessage(null);
    }

    try {
      const snapshot = await requestChapter(reference);
      if (!snapshot.verses.length) {
        if (!options.background) {
          setMessage(t('bibleWorkspace.chapterNotFound', {
            chapter: `${reference.bookLabel} ${reference.chapter}`
          }));
        }
        return null;
      }

      setChapterContext(snapshot.context);
      setChapterVerses(snapshot.verses);
      setMultiKeys(new Set());
      void prefetchAdjacentChapters(snapshot.context);
      return snapshot;
    } catch (error) {
      if (!options.background) {
        setMessage(t('bibleWorkspace.errors.chapter', {
          code: error instanceof Error ? error.message : 'unknown'
        }));
      }
      return null;
    } finally {
      if (ownsBusyState) setBusy(null);
    }
  }

  useEffect(() => {
    if (!liveParsed || !isBibleLive) return;
    const current = chapterContext;
    const sameChapter =
      current &&
      current.bookLabel.toLocaleLowerCase() === liveParsed.bookLabel.toLocaleLowerCase() &&
      current.chapter === liveParsed.chapter;
    if (!sameChapter) void loadChapter(liveParsed, { background: true });
    // liveReference changes only when the observed Bible frame changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveReference]);

  useEffect(() => {
    if (!externalQuery || !externalQueryNonce) return;
    setQuery(externalQuery);
    setView('search');

    const directReference = parseReference(externalQuery);
    if (!directReference) {
      setPickerOpen(true);
      setResults([]);
      setSelected(null);
      const matchingBook = findBibleBook(books, externalQuery);
      if (matchingBook) {
        setPickerBookId(matchingBook.id);
        setPickerChapter('1');
        setMessage(null);
      }
      return;
    }

    void (async () => {
      const matches = await performSearch(externalQuery);
      const parsed = parseReference(matches[0]?.reference || externalQuery);
      if (parsed) void loadChapter(parsed);
    })();
    // nonce intentionally turns repeated same-query commands into a new action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalQueryNonce]);

  useEffect(() => {
    if (!externalQuery || !externalQueryNonce || !books.length || parseReference(externalQuery)) return;
    const matchingBook = findBibleBook(books, externalQuery);
    if (!matchingBook) return;
    setPickerOpen(true);
    setPickerBookId(matchingBook.id);
    setPickerChapter('1');
    setMessage(null);
  }, [books, externalQuery, externalQueryNonce]);

  async function putOnAir(match: BibleReferenceMatch) {
    if (!canPresent || busy) return;
    setBusy('take');
    setMessage(null);
    try {
      if (
        !isBibleLive &&
        livePresentation?.song_id &&
        (currentPresentationProviderId || livePresentationEntry?.providerId)
      ) {
        setPreviousSong({
          providerId: currentPresentationProviderId || livePresentationEntry!.providerId,
          songId: String(livePresentation.song_id),
          title: String(livePresentation.name || livePresentation.title || t('liveControls.song')),
          slideIndex: Math.max(0, liveSlideIndex)
        });
      }

      const payload: Record<string, unknown> = match.ids.length
        ? { ids: match.ids }
        : { references: match.reference };
      if (selectedVersion) payload.version = selectedVersion.version;

      const response = await controller.executeCommand({
        capability: 'bible.present',
        payload,
        liveSessionId,
        actorId,
        safetyLevel: 'normal'
      });
      const failed = response.find(result => !result.accepted);
      if (failed) {
        setMessage(t('bibleWorkspace.errors.take', {
          code: failed.errorCode || 'provider_error'
        }));
        return;
      }

      setSelected(match);
      saveHistory(match);
      const presentation = presentationFromResults(response);
      if (presentation) onPresentation?.(presentation);
      setMessage(t('bibleWorkspace.onAir', { reference: match.reference }));
      const parsed = parseReference(match.reference);
      if (parsed) {
        setChapterContext(parsed);
        if (!sameChapter(parsed, chapterContext)) {
          void loadChapter(parsed, { background: true });
        } else {
          void prefetchAdjacentChapters(parsed);
        }
      }
    } catch (error) {
      setMessage(t('bibleWorkspace.errors.take', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    } finally {
      setBusy(null);
    }
  }

  async function putSelectedVerses() {
    const selectedVerses = chapterVerses.filter(verse =>
      multiKeys.has(verse.id || verse.reference)
    );
    if (!selectedVerses.length) return;
    const reference = selectedVerses.map(verse => verse.reference).join(', ');
    await putOnAir({
      reference,
      ids: selectedVerses.map(verse => verse.id).filter(Boolean),
      verses: selectedVerses
    });
  }

  async function returnToPreviousSong() {
    if (!previousSong || busy) return;
    setBusy('return');
    setMessage(null);
    try {
      const response = await controller.executeCommand({
        capability: 'songs.present',
        payload: {
          id: previousSong.songId,
          initialIndex: previousSong.slideIndex
        },
        liveSessionId,
        actorId,
        targetProviderIds: [previousSong.providerId],
        safetyLevel: 'normal'
      });
      const failed = response.find(result => !result.accepted);
      if (failed) {
        setMessage(t('bibleWorkspace.errors.returnSong', {
          code: failed.errorCode || 'provider_error'
        }));
        return;
      }
      const presentation = presentationFromResults(response);
      if (presentation) onPresentation?.(presentation);
      setMessage(t('bibleWorkspace.returnedToSong', { title: previousSong.title }));
    } catch (error) {
      setMessage(t('bibleWorkspace.errors.returnSong', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    } finally {
      setBusy(null);
    }
  }

  function reuse(item: SavedBibleReference) {
    setQuery(item.reference);
    setSelected(item);
    setResults([item]);
    if (item.version && versions.some(candidate =>
      candidate.key === item.version || candidate.version === item.version
    )) {
      setVersion(item.version);
    }
    setView('search');
    const parsed = parseReference(item.reference);
    if (parsed) void loadChapter(parsed);
  }

  function activateVerse(verse: BibleVerseReference) {
    const key = verse.id || verse.reference;
    if (multiSelect) {
      setMultiKeys(current => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }

    const now = performance.now();
    const previous = tapTarget.current;
    if (previous?.key === key && now - previous.at <= 380) {
      tapTarget.current = null;
      void putOnAir(verseAsMatch(verse));
      return;
    }
    tapTarget.current = { key, at: now };
    setSelected(verseAsMatch(verse));
  }

  async function adjacentVerse(
    reference: ParsedReference,
    delta: -1 | 1
  ): Promise<BibleVerseReference | null> {
    const currentSnapshot = await requestChapter(reference);
    const currentVerse = reference.verse;
    const currentIndex = currentSnapshot.verses.findIndex(verse => {
      const parsed = parseReference(verse.reference);
      return Boolean(
        parsed &&
        sameChapter(parsed, currentSnapshot.context) &&
        parsed.verse === currentVerse
      );
    });

    if (currentIndex >= 0) {
      const sameChapterCandidate = currentSnapshot.verses[currentIndex + delta];
      if (sameChapterCandidate) return sameChapterCandidate;
    }

    const adjacentChapterNumber = currentSnapshot.context.chapter + delta;
    if (adjacentChapterNumber > 0) {
      const adjacentSnapshot = await requestChapter({
        ...currentSnapshot.context,
        chapter: adjacentChapterNumber,
        verse: undefined
      });
      if (adjacentSnapshot.verses.length) {
        return delta > 0
          ? adjacentSnapshot.verses[0] || null
          : adjacentSnapshot.verses[adjacentSnapshot.verses.length - 1] || null;
      }
    }

    const acrossBook = await chapterAcrossBookBoundary(currentSnapshot.context, delta);
    if (!acrossBook?.verses.length) return null;
    return delta > 0
      ? acrossBook.verses[0] || null
      : acrossBook.verses[acrossBook.verses.length - 1] || null;
  }

  async function moveVerse(delta: -1 | 1) {
    const selectedReference = parseReference(selected?.reference || '');
    const reference = isBibleLive && liveParsed ? liveParsed : selectedReference;
    if (!reference?.verse || busy !== null) return;

    try {
      const candidate = await adjacentVerse(reference, delta);
      if (!candidate) {
        setMessage(t(delta > 0
          ? 'bibleWorkspace.noNextVerseFromProvider'
          : 'bibleWorkspace.noPreviousVerseFromProvider'));
        return;
      }
      await putOnAir(verseAsMatch(candidate));
    } catch (error) {
      setMessage(t('bibleWorkspace.errors.navigateVerse', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    }
  }

  async function moveChapter(delta: -1 | 1) {
    if (!chapterContext || busy !== null) return;
    const nextChapter = chapterContext.chapter + delta;

    if (nextChapter > 0) {
      const next = {
        ...chapterContext,
        chapter: nextChapter,
        verse: undefined
      };
      const snapshot = await loadChapter(next);
      if (snapshot) {
        setQuery(`${snapshot.context.bookLabel} ${snapshot.context.chapter}`);
        return;
      }
    }

    setBusy('chapter');
    setMessage(null);
    try {
      const snapshot = await chapterAcrossBookBoundary(chapterContext, delta);
      if (!snapshot?.verses.length) {
        setMessage(t(delta > 0
          ? 'bibleWorkspace.noNextChapterFromProvider'
          : 'bibleWorkspace.noPreviousChapterFromProvider'));
        return;
      }
      setChapterContext(snapshot.context);
      setChapterVerses(snapshot.verses);
      setMultiKeys(new Set());
      setQuery(`${snapshot.context.bookLabel} ${snapshot.context.chapter}`);
      setMessage(null);
      void prefetchAdjacentChapters(snapshot.context);
    } catch (error) {
      setMessage(t('bibleWorkspace.errors.chapter', {
        code: error instanceof Error ? error.message : 'unknown'
      }));
    } finally {
      setBusy(null);
    }
  }

  function openReferencePicker() {
    if (!pickerOpen) {
      const current =
        chapterContext ||
        (isBibleLive ? liveParsed : null) ||
        parseReference(selected?.reference || '');
      const currentBook = bookForContext(current);
      setPickerBookId(currentBook?.id || books[0]?.id || '');
      setPickerChapter(String(current?.chapter || 1));
    }
    setPickerOpen(current => !current);
  }

  async function selectPickerChapter(book: BibleBook, chapter: number) {
    if (busy !== null || !Number.isInteger(chapter) || chapter <= 0) return;
    setPickerBookId(book.id);
    setPickerChapter(String(chapter));
    const snapshot = await loadChapter(contextForBook(book, chapter));
    if (!snapshot) return;
    setQuery(`${snapshot.context.bookLabel} ${snapshot.context.chapter}`);
  }

  async function loadPickerChapter() {
    if (busy !== null) return;
    const book = books.find(item => item.id === pickerBookId);
    const chapter = Number.parseInt(pickerChapter, 10);
    if (!book || !Number.isFinite(chapter) || chapter <= 0) return;
    await selectPickerChapter(book, chapter);
  }

  const collection = view === 'favorites' ? favorites : history;
  const effectiveChapter = chapterContext || liveParsed;
  const selectedParsed = parseReference(selected?.reference || '');
  const focusReference = selectedParsed || (isBibleLive ? liveParsed : null);
  const activeVerseReference = liveReference || selected?.reference || '';

  const cachedCurrentChapter = effectiveChapter
    ? chapterCache.current.get(chapterSignature(effectiveChapter))
    : undefined;
  const effectiveVerses = cachedCurrentChapter?.verses.length
    ? cachedCurrentChapter.verses
    : chapterVerses;

  const pickerBook = books.find(item => item.id === pickerBookId);
  const pickerChapterNumber = Number.parseInt(pickerChapter, 10);
  const pickerChapterCount = chapterCountForBook(pickerBook);
  const pickerChapters = Array.from({ length: pickerChapterCount }, (_, index) => index + 1);
  const pickerContext =
    pickerBook && Number.isFinite(pickerChapterNumber) && pickerChapterNumber > 0
      ? contextForBook(pickerBook, pickerChapterNumber)
      : null;
  const pickerVerses =
    pickerContext && sameChapter(pickerContext, effectiveChapter)
      ? effectiveVerses
      : [];

  const navigationSnapshot = focusReference
    ? chapterCache.current.get(chapterSignature(focusReference))
    : undefined;
  const navigationVerses = navigationSnapshot?.verses.length
    ? navigationSnapshot.verses
    : sameChapter(focusReference, effectiveChapter)
      ? effectiveVerses
      : [];

  const navigationIndex = focusReference?.verse
    ? navigationVerses.findIndex(verse => {
        const parsed = parseReference(verse.reference);
        return parsed?.verse === focusReference.verse && sameChapter(parsed, focusReference);
      })
    : -1;

  const navigationContext =
    navigationSnapshot?.context ||
    (sameChapter(focusReference, effectiveChapter) ? effectiveChapter : focusReference);

  function cachedAdjacentSnapshot(delta: -1 | 1): ChapterSnapshot | undefined {
    if (!navigationContext) return undefined;
    const chapter = navigationContext.chapter + delta;
    if (chapter <= 0) return undefined;
    return chapterCache.current.get(chapterSignature({
      ...navigationContext,
      chapter,
      verse: undefined
    }));
  }

  function cachedBookBoundarySnapshot(delta: -1 | 1): ChapterSnapshot | undefined {
    if (!navigationContext || !books.length) return undefined;
    const currentBook = bookForContext(navigationContext);
    if (!currentBook) return undefined;
    const currentIndex = books.findIndex(book => book.id === currentBook.id);
    const adjacentBook = books[currentIndex + delta];
    if (!adjacentBook) return undefined;

    const snapshots = Array.from(chapterCache.current.values()).filter(snapshot => {
      const snapshotBook = bookForContext(snapshot.context);
      return snapshotBook?.id === adjacentBook.id && snapshot.verses.length > 0;
    });
    if (!snapshots.length) return undefined;
    return snapshots.sort((a, b) =>
      delta > 0
        ? a.context.chapter - b.context.chapter
        : b.context.chapter - a.context.chapter
    )[0];
  }

  const sameBookPrevious = cachedAdjacentSnapshot(-1);
  const sameBookNext = cachedAdjacentSnapshot(1);
  const previousChapterSnapshot = sameBookPrevious?.verses.length
    ? sameBookPrevious
    : cachedBookBoundarySnapshot(-1);
  const nextChapterSnapshot = sameBookNext?.verses.length
    ? sameBookNext
    : cachedBookBoundarySnapshot(1);
  const previousVerseCandidate = navigationIndex > 0
    ? navigationVerses[navigationIndex - 1]
    : previousChapterSnapshot?.verses[previousChapterSnapshot.verses.length - 1];
  const nextVerseCandidate = navigationIndex >= 0 && navigationIndex < navigationVerses.length - 1
    ? navigationVerses[navigationIndex + 1]
    : nextChapterSnapshot?.verses[0];

  const verseWindow = useMemo(() => {
    if (!focusReference || navigationIndex < 0) return [] as BibleVerseReference[];
    const radius = 3;
    const before = navigationVerses.slice(Math.max(0, navigationIndex - radius), navigationIndex);
    const after = navigationVerses.slice(navigationIndex + 1, navigationIndex + radius + 1);

    if (before.length < radius && previousChapterSnapshot?.verses.length) {
      before.unshift(...previousChapterSnapshot.verses.slice(-(radius - before.length)));
    }
    if (after.length < radius && nextChapterSnapshot?.verses.length) {
      after.push(...nextChapterSnapshot.verses.slice(0, radius - after.length));
    }

    return [
      ...before,
      navigationVerses[navigationIndex]!,
      ...after
    ];
  }, [
    chapterCacheEpoch,
    focusReference?.bookLabel,
    focusReference?.chapter,
    focusReference?.verse,
    navigationIndex,
    navigationVerses
  ]);

  useEffect(() => {
    if (!isBibleLive) {
      previousLiveVerseId.current = '';
      return;
    }
    if (!liveVerseId || !cachedLiveVerse) return;

    const previousId = previousLiveVerseId.current;
    previousLiveVerseId.current = liveVerseId;
    setSelected(current => {
      const currentId = current?.ids.length === 1 ? current.ids[0] : '';
      const shouldFollowLive =
        !current ||
        currentId === liveVerseId ||
        (previousId && currentId === previousId);
      return shouldFollowLive ? verseAsMatch(cachedLiveVerse) : current;
    });
  }, [cachedLiveVerse?.id, isBibleLive, liveVerseId]);

  useEffect(() => {
    const reference = selected?.reference || (isBibleLive ? liveReference : '');
    if (!reference) return;
    const frame = window.requestAnimationFrame(() => {
      const node = verseListRef.current?.querySelector<HTMLElement>(
        `[data-verse-reference="${CSS.escape(reference)}"]`
      );
      node?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest'
      });
      smartRailRef.current?.querySelector<HTMLElement>('.focused')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center'
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chapterCacheEpoch, isBibleLive, liveReference, selected?.reference]);

  useEffect(() => {
    if (!books.length || !chapterContext) return;
    void prefetchAdjacentChapters(chapterContext);
    // Book discovery is progressive enhancement for cross-book navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books.length]);

  return (
    <article className="operator-card live-tool-card bible-workspace bible-reader-workspace">
      <div className="bible-workspace-head">
        <div>
          <span className="eyebrow">{t('bibleWorkspace.kicker')}</span>
          <strong>{t('bibleWorkspace.title')}</strong>
          <small>{t('bibleWorkspace.subtitle')}</small>
        </div>
        <div className="bible-version-control">
          <label htmlFor="live-bible-version">{t('bibleWorkspace.version')}</label>
          <select
            id="live-bible-version"
            value={version}
            onChange={event => {
              setVersion(event.target.value);
              chapterCache.current.clear();
              chapterRequests.current.clear();
              setChapterCacheEpoch(current => current + 1);
            }}
            disabled={!canPresent || versionsLoading || busy === 'take'}
          >
            <option value="">{t('bibleWorkspace.providerDefault')}</option>
            {versions.map(item => (
              <option key={`${item.key}:${item.version}`} value={item.key}>
                {item.title}{item.languageIso ? ` · ${item.languageIso.toUpperCase()}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className={isBibleLive ? 'bible-live-strip active' : 'bible-live-strip'}>
        <div className="bible-live-status">
          <span />
          <div>
            <small>{isBibleLive ? t('bibleWorkspace.onAirNow') : t('bibleWorkspace.liveContext')}</small>
            <strong>{isBibleLive
              ? liveReference || String(livePresentation?.name || t('bibleWorkspace.bibleOnAir'))
              : t('bibleWorkspace.noBibleOnAir')}</strong>
          </div>
        </div>
        {isBibleLive && liveVerseText && <p>{liveVerseText}</p>}
        {previousSong && (
          <button
            type="button"
            className="bible-return-song"
            disabled={busy !== null}
            onClick={() => void returnToPreviousSong()}
          >
            ← {t('bibleWorkspace.returnToSong', { title: previousSong.title })}
          </button>
        )}
      </section>

      <div className="bible-search-command">
        <div className="bible-search-row">
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void search();
            }}
            placeholder={t('bibleWorkspace.placeholder')}
            disabled={!canPresent}
            autoCapitalize="sentences"
          />
          <button
            className="primary"
            type="button"
            disabled={!query.trim() || !canPresent || busy !== null}
            onClick={() => void search()}
          >
            {busy === 'search' ? t('bibleWorkspace.searching') : t('bibleWorkspace.goToPassage')}
          </button>
        </div>
        <small>{t('bibleWorkspace.searchExamples')}</small>
      </div>

      {canReadBooks && (
        <section className={pickerOpen ? 'bible-reference-picker open' : 'bible-reference-picker'}>
          <button
            type="button"
            className="bible-reference-picker-toggle"
            onClick={openReferencePicker}
            disabled={booksLoading && !books.length}
            aria-expanded={pickerOpen}
          >
            <span>
              <strong>{t('bibleWorkspace.picker.title')}</strong>
              <small>{t('bibleWorkspace.picker.subtitle')}</small>
            </span>
            <em>{pickerOpen ? t('bibleWorkspace.picker.close') : t('bibleWorkspace.picker.open')}</em>
          </button>

          {pickerOpen && (
            <div className="bible-reference-picker-body">
              <div className="bible-holyrics-picker">
                <section className="bible-picker-panel bible-picker-books">
                  <header>
                    <span>{t('bibleWorkspace.picker.book')}</span>
                    <small>{t('bibleWorkspace.picker.bookHint')}</small>
                  </header>
                  <div className="bible-book-grid" aria-label={t('bibleWorkspace.picker.book')}>
                    {books.map(book => {
                      const active = book.id === pickerBookId;
                      return (
                        <button
                          key={book.id}
                          type="button"
                          className={[
                            'bible-book-tile',
                            bibleBookGroup(book),
                            active ? 'active' : ''
                          ].filter(Boolean).join(' ')}
                          disabled={booksLoading || busy !== null}
                          onClick={() => {
                            setPickerBookId(book.id);
                            setPickerChapter('1');
                            setMessage(null);
                          }}
                        >
                          <strong>{book.abbrev || book.name}</strong>
                          <small>{book.name}</small>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="bible-picker-panel bible-picker-chapters">
                  <header>
                    <span>{t('bibleWorkspace.picker.chapter')}</span>
                    <small>
                      {pickerBook
                        ? t('bibleWorkspace.picker.chapterHint', {
                            book: pickerBook.name,
                            count: pickerChapterCount
                          })
                        : t('bibleWorkspace.picker.chooseBook')}
                    </small>
                  </header>

                  {pickerBook && pickerChapters.length > 0 && (
                    <div className="bible-chapter-grid" aria-label={t('bibleWorkspace.picker.chapter')}>
                      {pickerChapters.map(chapter => (
                        <button
                          key={chapter}
                          type="button"
                          className={chapter === pickerChapterNumber ? 'active' : ''}
                          disabled={busy !== null}
                          onClick={() => void selectPickerChapter(pickerBook, chapter)}
                        >
                          {chapter}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="bible-chapter-direct">
                    <label>
                      <span>{t('bibleWorkspace.picker.chapterDirect')}</span>
                      <input
                        type="number"
                        min="1"
                        max={pickerChapterCount || undefined}
                        inputMode="numeric"
                        value={pickerChapter}
                        onChange={event => setPickerChapter(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void loadPickerChapter();
                        }}
                        disabled={busy !== null || !pickerBook}
                      />
                    </label>
                    <button
                      type="button"
                      className="primary bible-reference-picker-load"
                      disabled={
                        busy !== null ||
                        !pickerBook ||
                        !Number.isFinite(pickerChapterNumber) ||
                        pickerChapterNumber <= 0 ||
                        (pickerChapterCount > 0 && pickerChapterNumber > pickerChapterCount)
                      }
                      onClick={() => void loadPickerChapter()}
                    >
                      {busy === 'chapter'
                        ? t('bibleWorkspace.loadingChapter')
                        : t('bibleWorkspace.picker.loadChapter')}
                    </button>
                  </div>
                </section>
              </div>

              {booksLoading && !books.length && (
                <div className="bible-picker-status">{t('bibleWorkspace.picker.loadingBooks')}</div>
              )}

              {pickerVerses.length > 0 && (
                <div className="bible-picker-verses" aria-label={t('bibleWorkspace.picker.verses')}>
                  {pickerVerses.map(verse => {
                    const parsed = parseReference(verse.reference);
                    const key = verseIdentity(verse);
                    const selectedKey = selected ? savedKey(selected) : '';
                    const prepared = selectedKey === savedKey(verseAsMatch(verse));
                    const onAir = Boolean(
                      isBibleLive &&
                      (
                        (liveVerseId && verse.id === liveVerseId) ||
                        (
                          parsed &&
                          liveParsed &&
                          parsed.verse === liveParsed.verse &&
                          sameChapter(parsed, liveParsed)
                        )
                      )
                    );
                    return (
                      <button
                        key={key}
                        type="button"
                        className={[
                          'bible-picker-verse',
                          prepared ? 'prepared' : '',
                          onAir ? 'on-air' : ''
                        ].filter(Boolean).join(' ')}
                        onClick={() => activateVerse(verse)}
                        disabled={busy === 'take' || busy === 'return'}
                        title={verse.reference}
                      >
                        <strong>{parsed?.verse || verse.verse || '—'}</strong>
                        <small>{onAir
                          ? t('bibleWorkspace.onAirBadge')
                          : prepared
                            ? t('bibleWorkspace.ready')
                            : t('bibleWorkspace.preview')}</small>
                      </button>
                    );
                  })}
                </div>
              )}

              {pickerBook && pickerVerses.length === 0 && busy !== 'chapter' && (
                <small className="bible-picker-hint">{t('bibleWorkspace.picker.hint')}</small>
              )}
            </div>
          )}
        </section>
      )}

      {verseWindow.length > 0 && (
        <section className="bible-smart-window" aria-label={t('bibleWorkspace.smartWindow')}>
          <div className="bible-smart-window-head">
            <div>
              <small>{t('bibleWorkspace.smartWindow')}</small>
              <strong>{t('bibleWorkspace.smartWindowHint')}</strong>
            </div>
            <span>{t('bibleWorkspace.providerVerified')}</span>
          </div>
          <div ref={smartRailRef} className="bible-smart-verse-rail">
            {verseWindow.map(verse => {
              const parsed = parseReference(verse.reference);
              const onAir = Boolean(
                isBibleLive &&
                (
                  (liveVerseId && verse.id && verse.id === liveVerseId) ||
                  (
                    liveParsed &&
                    parsed &&
                    parsed.verse === liveParsed.verse &&
                    sameChapter(parsed, liveParsed)
                  )
                )
              );
              const focused = Boolean(
                focusReference &&
                parsed &&
                parsed.verse === focusReference.verse &&
                sameChapter(parsed, focusReference)
              );
              return (
                <button
                  key={verseIdentity(verse)}
                  type="button"
                  className={[
                    'bible-smart-verse',
                    onAir ? 'on-air' : '',
                    focused ? 'focused' : ''
                  ].filter(Boolean).join(' ')}
                  onClick={() => activateVerse(verse)}
                  disabled={busy === 'take' || busy === 'return'}
                >
                  <small>{verse.reference}</small>
                  <strong>{parsed?.verse ?? verse.verse ?? '—'}</strong>
                  <span>
                    {verse.text || t('bibleWorkspace.providerReferenceVerified')}
                  </span>
                  <em>
                    {onAir
                      ? t('bibleWorkspace.onAirBadge')
                      : focused
                        ? t('bibleWorkspace.ready')
                        : t('bibleWorkspace.preview')}
                  </em>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {effectiveChapter && (
        <section className="bible-chapter-reader">
          <header className="bible-chapter-nav">
            <button
              type="button"
              disabled={busy !== null || effectiveChapter.chapter <= 1}
              onClick={() => void moveChapter(-1)}
            >
              ← {t('bibleWorkspace.previousChapter')}
            </button>
            <div>
              <small>{t('bibleWorkspace.chapter')}</small>
              <strong>{effectiveChapter.bookLabel} {effectiveChapter.chapter}</strong>
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void moveChapter(1)}
            >
              {t('bibleWorkspace.nextChapter')} →
            </button>
          </header>

          <div className="bible-reader-actions">
            <button
              type="button"
              disabled={busy !== null || !previousVerseCandidate}
              onClick={() => void moveVerse(-1)}
            >
              <span>← {t('bibleWorkspace.previousVerse')}</span>
              {previousVerseCandidate && <small>{previousVerseCandidate.reference}</small>}
            </button>
            <button
              type="button"
              className={multiSelect ? 'active' : ''}
              onClick={() => {
                setMultiSelect(value => !value);
                setMultiKeys(new Set());
              }}
            >
              {multiSelect
                ? t('bibleWorkspace.cancelMulti')
                : t('bibleWorkspace.selectMultiple')}
            </button>
            <button
              type="button"
              disabled={busy !== null || !nextVerseCandidate}
              onClick={() => void moveVerse(1)}
            >
              <span>{t('bibleWorkspace.nextVerse')} →</span>
              {nextVerseCandidate && <small>{nextVerseCandidate.reference}</small>}
            </button>
          </div>

          <div ref={verseListRef} className="bible-verse-reader" aria-live="polite">
            {busy === 'chapter' && (
              <div className="bible-chapter-loading">{t('bibleWorkspace.loadingChapter')}</div>
            )}
            {effectiveVerses.map((verse, index) => {
              const key = verse.id || verse.reference;
              const parsedVerse = parseReference(verse.reference);
              const onAir = Boolean(
                isBibleLive &&
                (
                  (liveVerseId && verse.id && verse.id === liveVerseId) ||
                  (
                    activeVerseReference &&
                    verse.reference.toLocaleLowerCase() === activeVerseReference.toLocaleLowerCase()
                  ) ||
                  (
                    parsedVerse?.verse &&
                    liveParsed &&
                    parsedVerse.verse === liveParsed.verse &&
                    sameChapter(parsedVerse, liveParsed)
                  )
                )
              );
              const selectedVerse = multiKeys.has(key);
              return (
                <button
                  key={key || index}
                  type="button"
                  data-verse-reference={verse.reference}
                  className={[
                    'bible-verse-row',
                    onAir ? 'on-air' : '',
                    selectedVerse ? 'selected' : ''
                  ].filter(Boolean).join(' ')}
                  onClick={() => activateVerse(verse)}
                  disabled={busy === 'take' || busy === 'return'}
                >
                  <span className="bible-verse-number">
                    {parseReference(verse.reference)?.verse || verse.verse || index + 1}
                  </span>
                  <span className="bible-verse-copy">
                    <small>{verse.reference}</small>
                    <strong>{verse.text || t('bibleWorkspace.providerReferenceVerified')}</strong>
                  </span>
                  <em>
                    {onAir
                      ? t('bibleWorkspace.onAirBadge')
                      : selectedVerse
                        ? t('bibleWorkspace.selected')
                        : t('bibleWorkspace.preview')}
                  </em>
                </button>
              );
            })}
            {!effectiveVerses.length && busy !== 'chapter' && (
              <div className="bible-chapter-empty">
                <strong>{t('bibleWorkspace.chapterReferencesUnavailable')}</strong>
                <span>{t('bibleWorkspace.chapterReferencesFallback')}</span>
              </div>
            )}
          </div>

          {multiSelect && multiKeys.size > 0 && (
            <div className="bible-multi-take">
              <span>{t('bibleWorkspace.selectedCount', { count: multiKeys.size })}</span>
              <button
                type="button"
                className="primary"
                disabled={busy !== null}
                onClick={() => void putSelectedVerses()}
              >
                {t('bibleWorkspace.showSelected', { count: multiKeys.size })}
              </button>
            </div>
          )}
        </section>
      )}

      <div className="bible-view-tabs" role="tablist" aria-label={t('bibleWorkspace.library')}>
        {(['search', 'favorites', 'history'] as const).map(item => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            className={view === item ? 'active' : ''}
            onClick={() => setView(item)}
          >
            <span>{t(`bibleWorkspace.tabs.${item}`)}</span>
            {item === 'favorites' && favorites.length > 0 && <b>{favorites.length}</b>}
            {item === 'history' && history.length > 0 && <b>{history.length}</b>}
          </button>
        ))}
      </div>

      {view === 'search' ? (
        <div className="bible-results bible-quick-results" aria-live="polite">
          {results.map(match => {
            const key = savedKey(match);
            const active = selected ? savedKey(selected) === key : false;
            return (
              <section key={key} className={`bible-result-card ${active ? 'selected' : ''}`}>
                <button
                  type="button"
                  className="bible-result-main"
                  onClick={() => {
                    setSelected(match);
                    const parsed = parseReference(match.reference);
                    if (parsed) void loadChapter(parsed);
                  }}
                >
                  <span>
                    <strong>{match.reference}</strong>
                    <small>
                      {match.ids.length
                        ? t('bibleWorkspace.verseCount', { count: match.ids.length })
                        : t('bibleWorkspace.referenceReady')}
                    </small>
                  </span>
                  <em>{active ? t('bibleWorkspace.ready') : t('bibleWorkspace.preview')}</em>
                </button>

                {active && (
                  <div className="bible-result-detail">
                    <div className="bible-result-actions">
                      <button
                        type="button"
                        className={favoriteKeys.has(key) ? 'bible-favorite active' : 'bible-favorite'}
                        aria-pressed={favoriteKeys.has(key)}
                        onClick={() => toggleFavorite(match)}
                      >
                        {favoriteKeys.has(key)
                          ? t('bibleWorkspace.removeFavorite')
                          : t('bibleWorkspace.addFavorite')}
                      </button>
                      <button
                        type="button"
                        className="primary bible-take"
                        disabled={!canPresent || busy !== null}
                        onClick={() => void putOnAir(match)}
                      >
                        {busy === 'take'
                          ? t('bibleWorkspace.sending')
                          : t('bibleWorkspace.putOnAir')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            );
          })}

          {query.trim() && results.length === 0 && busy !== 'search' && !message && (
            <div className="bible-empty">{t('bibleWorkspace.searchHint')}</div>
          )}
        </div>
      ) : (
        <div className="bible-saved-list">
          {collection.length ? collection.map(item => {
            const key = `${savedKey(item)}:${item.savedAt}`;
            return (
              <button key={key} type="button" onClick={() => reuse(item)}>
                <span>
                  <strong>{item.reference}</strong>
                  <small>
                    {item.version || t('bibleWorkspace.providerDefault')}
                    {' · '}
                    {new Date(item.savedAt).toLocaleString()}
                  </small>
                </span>
                <em>{t('bibleWorkspace.useAgain')}</em>
              </button>
            );
          }) : (
            <div className="bible-empty">
              {view === 'favorites'
                ? t('bibleWorkspace.noFavorites')
                : t('bibleWorkspace.noHistory')}
            </div>
          )}
        </div>
      )}

      {!canSearch && canPresent && (
        <p className="bible-capability-note">{t('bibleWorkspace.directReferenceOnly')}</p>
      )}
      {message && <p className="bible-workspace-message" role="status">{message}</p>}
    </article>
  );
}
