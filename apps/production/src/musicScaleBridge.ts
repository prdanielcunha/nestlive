import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';

export interface SharedOrganization {
  id: string;
  name: string;
  role?: string;
}

export interface SharedContext {
  organizationId: string;
  organizationName: string;
  profileName: string;
  systemRole?: string;
  organizations: SharedOrganization[];
}

export interface SharedScaleSong {
  id: string;
  title: string;
  artist?: string;
  key?: string;
  bpm?: number | null;
  selectedKey?: string;
  selectedBpm?: number | null;
  lyrics?: string;
  chords?: string;
  version?: string;
}

export interface SharedScale {
  id: string;
  organizationId: string;
  organizationName?: string;
  date: string;
  time?: string;
  timeZone?: string;
  publishRevision?: number;
  observations?: string;
  eventName?: string;
  locationId?: string;
  locationName?: string;
  status?: string;
  durationMinutes?: number;
  songIds: string[];
  songs: SharedScaleSong[];
}

export type ScaleOperationalState = 'live' | 'upcoming' | 'recent' | 'past';

const GLOBAL_ORGANIZATION_ROLES = new Set([
  'ceo',
  'admin',
  'global_admin',
  'ecosystem_owner',
  'founder'
]);

function normalizedRole(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function candidateOrganizationIds(profile: Record<string, unknown>): string[] {
  const candidates = [
    profile.activeOrganizationId,
    profile.organizationId,
    profile.primaryOrganizationId
  ];
  return [...new Set(
    candidates
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => String(value))
  )];
}

function membershipOrganizationId(item: {
  data: () => Record<string, unknown>;
  ref?: { parent?: { parent?: { id?: string } | null } };
}): string | null {
  const data = item.data();
  const direct = data.organizationId || data.organization_id;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const parentId = item.ref?.parent?.parent?.id;
  return typeof parentId === 'string' && parentId.trim() ? parentId : null;
}

function membershipRole(data: Record<string, unknown>): string | undefined {
  const role = data.organizationRole || data.musicscaleRole || data.role || data.ministryFunction;
  return typeof role === 'string' && role.trim() ? role : undefined;
}

async function discoverOrganizations(
  user: User,
  profile: Record<string, unknown>
): Promise<SharedOrganization[]> {
  const discovered = new Map<string, Partial<SharedOrganization>>();

  for (const id of candidateOrganizationIds(profile)) {
    discovered.set(id, {
      id,
      role: typeof profile.organizationRole === 'string'
        ? profile.organizationRole
        : typeof profile.role === 'string'
          ? profile.role
          : undefined
    });
  }

  const discoveryQueries = [
    getDocs(query(collection(db, 'organizations'), where('ownerUid', '==', user.uid))),
    getDocs(query(collection(db, 'organizations'), where('ownerUserId', '==', user.uid))),
    getDocs(query(collectionGroup(db, 'members'), where('uid', '==', user.uid))),
    getDocs(query(collectionGroup(db, 'members'), where('userId', '==', user.uid))),
    getDocs(query(collection(db, 'organization_members'), where('uid', '==', user.uid))),
    getDocs(query(collection(db, 'organization_members'), where('userId', '==', user.uid))),
    getDocs(query(collection(db, 'organization_members'), where('user_id', '==', user.uid)))
  ];

  const discoveryResults = await Promise.allSettled(discoveryQueries);

  for (const index of [0, 1]) {
    const result = discoveryResults[index];
    if (result?.status !== 'fulfilled') continue;
    for (const orgDoc of result.value.docs) {
      const data = orgDoc.data();
      discovered.set(orgDoc.id, {
        id: orgDoc.id,
        name: String(data.name || ''),
        role: 'owner'
      });
    }
  }

  for (const index of [2, 3, 4, 5, 6]) {
    const result = discoveryResults[index];
    if (result?.status !== 'fulfilled') continue;
    for (const membershipDoc of result.value.docs) {
      const id = membershipOrganizationId(membershipDoc as never);
      if (!id) continue;
      const data = membershipDoc.data();
      const previous = discovered.get(id);
      discovered.set(id, {
        id,
        name: previous?.name,
        role: membershipRole(data) || previous?.role
      });
    }
  }

  const systemRole = normalizedRole(
    profile.systemRole || profile.globalRole || profile.ecosystemRole
  );
  if (GLOBAL_ORGANIZATION_ROLES.has(systemRole)) {
    try {
      const allOrganizations = await getDocs(collection(db, 'organizations'));
      for (const orgDoc of allOrganizations.docs) {
        const data = orgDoc.data();
        if (data.status === 'archived' || data.archived === true) continue;
        const existing = discovered.get(orgDoc.id);
        discovered.set(orgDoc.id, {
          id: orgDoc.id,
          name: String(data.name || existing?.name || 'Organização'),
          role: existing?.role || 'global_access'
        });
      }
    } catch {
      // Least-privilege Firestore rules may intentionally hide the global catalog.
    }
  }

  const hydrated = await Promise.all(
    [...discovered.values()].map(async organization => {
      if (!organization.id) return null;
      try {
        const snapshot = await getDoc(doc(db, 'organizations', organization.id));
        if (!snapshot.exists()) return null;
        const data = snapshot.data();
        if (data.status === 'archived' || data.archived === true) return null;
        return {
          id: organization.id,
          name: String(data.name || organization.name || 'Organização'),
          role: organization.role
        } satisfies SharedOrganization;
      } catch {
        return organization.name
          ? {
              id: organization.id,
              name: String(organization.name),
              role: organization.role
            } satisfies SharedOrganization
          : null;
      }
    })
  );

  const visible = hydrated.filter(
    (item): item is NonNullable<(typeof hydrated)[number]> => item !== null
  );
  return visible.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSharedContext(user: User): Promise<SharedContext | null> {
  const userSnap = await getDoc(doc(db, 'users', user.uid));
  if (!userSnap.exists()) return null;

  const profile = userSnap.data();
  const organizations = await discoverOrganizations(user, profile);
  if (!organizations.length) return null;

  const preferredIds = candidateOrganizationIds(profile);
  const preferred = preferredIds
    .map(id => organizations.find(item => item.id === id))
    .find(Boolean);
  const active = preferred || organizations[0]!;
  const systemRole = normalizedRole(
    profile.systemRole || profile.globalRole || profile.ecosystemRole
  );

  return {
    organizationId: active.id,
    organizationName: active.name,
    profileName: String(profile.displayName || user.displayName || user.email || ''),
    systemRole: systemRole || undefined,
    organizations
  };
}

function numberOrUndefined(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

export async function loadOrganizationScales(
  organization: SharedOrganization
): Promise<SharedScale[]> {
  const organizationId = organization.id;
  const [scaleSnap, songSnap, eventNamesSnap, locationsSnap] = await Promise.all([
    getDocs(query(collection(db, 'scales'), where('organizationId', '==', organizationId))),
    getDocs(query(collection(db, 'songs'), where('organizationId', '==', organizationId))),
    getDocs(query(collection(db, 'eventNames'), where('organizationId', '==', organizationId))),
    getDocs(query(collection(db, 'locations'), where('organizationId', '==', organizationId)))
  ]);

  const songsById = new Map(songSnap.docs.map(item => [item.id, item.data()]));
  const eventNamesById = new Map(eventNamesSnap.docs.map(item => [item.id, item.data()]));
  const locationsById = new Map(locationsSnap.docs.map(item => [item.id, item.data()]));

  return scaleSnap.docs
    .map(item => ({ id: item.id, ...item.data() } as Record<string, any>))
    .filter(item => item.status !== 'cancelled' && item.status !== 'canceled')
    .map(item => {
      const songIds = Array.isArray(item.songIds) ? item.songIds.map(String) : [];
      return {
        id: String(item.id),
        organizationId,
        organizationName: organization.name,
        date: String(item.date || ''),
        time: item.time ? String(item.time) : undefined,
        timeZone: item.timeZone ? String(item.timeZone) : undefined,
        publishRevision: Number.isInteger(item.publishRevision)
          ? Number(item.publishRevision)
          : undefined,
        observations: item.observations ? String(item.observations) : undefined,
        eventName: item.eventNameId
          ? String(eventNamesById.get(item.eventNameId)?.name || '')
          : item.eventName
            ? String(item.eventName)
            : undefined,
        locationId: item.locationId ? String(item.locationId) : undefined,
        locationName: item.locationId
          ? String(locationsById.get(item.locationId)?.name || '')
          : item.locationName
            ? String(item.locationName)
            : undefined,
        status: item.status ? String(item.status) : undefined,
        durationMinutes: numberOrUndefined(
          item.durationMinutes,
          item.estimatedDurationMinutes,
          item.plannedDurationMinutes
        ),
        songIds,
        songs: songIds.map((id: string) => {
          const song = songsById.get(id) || {};
          const settings = item.songSettings?.[id] || {};
          return {
            id,
            title: String(song.title || 'Música'),
            artist: song.artist ? String(song.artist) : undefined,
            key: song.key ? String(song.key) : undefined,
            bpm: typeof song.bpm === 'number' ? song.bpm : null,
            selectedKey: settings.key ? String(settings.key) : undefined,
            selectedBpm: typeof settings.bpm === 'number' ? settings.bpm : null,
            lyrics: typeof song.lyrics === 'string' ? song.lyrics : undefined,
            chords: typeof song.chords === 'string' ? song.chords : undefined,
            version: song.version ? String(song.version) : undefined
          };
        })
      } satisfies SharedScale;
    })
    .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date));
}

export function scaleStartMs(scale: SharedScale): number {
  const rawTime = scale.time?.trim() || '';
  const hasSeconds = /^\d{1,2}:\d{2}:\d{2}$/.test(rawTime);
  const hasMinutes = /^\d{1,2}:\d{2}$/.test(rawTime);
  const normalizedTime = hasSeconds
    ? rawTime
    : hasMinutes
      ? `${rawTime}:00`
      : '23:59:00';
  const value = new Date(`${scale.date}T${normalizedTime}`).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function getScaleOperationalState(
  scale: SharedScale,
  now = Date.now()
): ScaleOperationalState {
  const normalizedStatus = normalizedRole(scale.status).replace(/[ -]+/g, '_');
  if (['live', 'in_progress', 'ongoing', 'em_andamento', 'started'].includes(normalizedStatus)) {
    return 'live';
  }

  const start = scaleStartMs(scale);
  const hasClockTime = Boolean(scale.time && /^\d{1,2}:\d{2}/.test(scale.time));
  const durationMs = (scale.durationMinutes || 240) * 60_000;

  if (hasClockTime && start <= now && now <= start + durationMs) return 'live';
  if (start > now) return 'upcoming';
  if (now - start <= 6 * 60 * 60_000) return 'recent';
  return 'past';
}

export function resolveOperationalScale(
  scales: SharedScale[],
  now = Date.now()
): SharedScale | null {
  if (!scales.length) return null;

  const live = scales
    .filter(scale => getScaleOperationalState(scale, now) === 'live')
    .sort((a, b) => scaleStartMs(b) - scaleStartMs(a));
  if (live.length) return live[0]!;

  const upcoming = scales
    .filter(scale => getScaleOperationalState(scale, now) === 'upcoming')
    .sort((a, b) => scaleStartMs(a) - scaleStartMs(b));
  if (upcoming.length) return upcoming[0]!;

  const recent = scales
    .filter(scale => getScaleOperationalState(scale, now) === 'recent')
    .sort((a, b) => scaleStartMs(b) - scaleStartMs(a));
  if (recent.length) return recent[0]!;

  return [...scales].sort((a, b) => scaleStartMs(b) - scaleStartMs(a))[0] || null;
}

export async function loadLiveScales(
  organizations: SharedOrganization[]
): Promise<SharedScale[]> {
  const results = await Promise.allSettled(
    organizations.map(organization => loadOrganizationScales(organization))
  );
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

export async function loadNextScale(organizationId: string): Promise<SharedScale | null> {
  let organizationName = 'Organização';
  try {
    const organizationSnapshot = await getDoc(doc(db, 'organizations', organizationId));
    if (organizationSnapshot.exists()) {
      organizationName = String(organizationSnapshot.data().name || organizationName);
    }
  } catch {
    // Name is display metadata only.
  }
  const scales = await loadOrganizationScales({
    id: organizationId,
    name: organizationName
  });
  return resolveOperationalScale(scales);
}

export function subscribeLiveScales(
  organizations: SharedOrganization[],
  onScales: (scales: SharedScale[]) => void,
  onError?: (error: Error) => void
): () => void {
  let disposed = false;
  const byOrganization = new Map<string, SharedScale[]>();
  const generations = new Map<string, number>();

  const emit = () => {
    if (disposed) return;
    onScales([...byOrganization.values()].flat());
  };

  const refresh = (organization: SharedOrganization) => {
    const generation = (generations.get(organization.id) || 0) + 1;
    generations.set(organization.id, generation);
    void loadOrganizationScales(organization)
      .then(scales => {
        if (disposed || generations.get(organization.id) !== generation) return;
        byOrganization.set(organization.id, scales);
        emit();
      })
      .catch(error => {
        if (disposed || generations.get(organization.id) !== generation) return;
        onError?.(error instanceof Error ? error : new Error('scale_realtime_refresh_failed'));
      });
  };

  const unsubscribers = organizations.map(organization => onSnapshot(
    query(collection(db, 'scales'), where('organizationId', '==', organization.id)),
    () => refresh(organization),
    error => onError?.(error)
  ));

  return () => {
    disposed = true;
    unsubscribers.forEach(unsubscribe => unsubscribe());
  };
}

export function subscribeNextScale(
  organizationId: string,
  onScale: (scale: SharedScale | null) => void,
  onError?: (error: Error) => void
): () => void {
  const organization: SharedOrganization = {
    id: organizationId,
    name: 'Organização'
  };
  return subscribeLiveScales(
    [organization],
    scales => onScale(resolveOperationalScale(scales)),
    onError
  );
}
