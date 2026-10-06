import type {
  LiveCollaborationGrant,
  LiveNodeTransportKind,
  PairingBinding
} from '@millionsnest/nestlive-production-domain';

export interface StoredLiveNodeCredential {
  baseUrl: string;
  transportKind?: LiveNodeTransportKind;
  token: string;
  binding: PairingBinding;
  collaboration?: LiveCollaborationGrant;
}

const DB_NAME = 'nestlive';
const LEGACY_DB_NAME = 'millionsnest-live';
const STORE_NAME = 'secure-local';
const KEY = 'live-node-credential';
const DB_VERSION = 1;

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCredential(name: string): Promise<StoredLiveNodeCredential | null> {
  const db = await openDb(name);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () =>
        resolve((request.result as StoredLiveNodeCredential | undefined) || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeCredential(
  name: string,
  value: StoredLiveNodeCredential
): Promise<void> {
  const db = await openDb(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteCredential(name: string): Promise<void> {
  const db = await openDb(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadLiveNodeCredential(): Promise<StoredLiveNodeCredential | null> {
  const current = await readCredential(DB_NAME);
  if (current) return current;

  // Rolling brand migration: preserve existing paired browsers automatically.
  const legacy = await readCredential(LEGACY_DB_NAME).catch(() => null);
  if (!legacy) return null;

  await writeCredential(DB_NAME, legacy);
  return legacy;
}

export async function saveLiveNodeCredential(
  value: StoredLiveNodeCredential
): Promise<void> {
  await writeCredential(DB_NAME, value);
}

export async function clearLiveNodeCredential(): Promise<void> {
  await Promise.allSettled([
    deleteCredential(DB_NAME),
    deleteCredential(LEGACY_DB_NAME)
  ]);
}
