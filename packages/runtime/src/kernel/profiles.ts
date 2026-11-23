import { BOX_ID, dbName, profileKernel } from './instance';

/**
 * The profiles of a BrowserBox site: who uses it, each with a kernel of their
 * own (files, settings, API keys, chats). The list lives in this origin's
 * IndexedDB next to the profiles' own stores, readable by every window of the
 * site before any kernel starts. "default" is the first profile: its data is
 * where it always was, so it can be renamed but not deleted.
 */
export interface Profile {
  id: string;
  name: string;
  created: number;
  /** Shown as locked until signed in (the key store has the truth). */
  password: boolean;
}

export const DEFAULT_PROFILE = 'default';
const DB = 'bbx-profiles';
const STORE = 'profiles';
const LAST = '#last';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const fallback = (): Profile => ({ id: DEFAULT_PROFILE, name: 'Default', created: 0, password: false });

/** Every profile, the first one first. */
export async function listProfiles(): Promise<Profile[]> {
  const all = (await run<Profile[]>('readonly', (s) => s.getAll())).filter((p) => p && typeof p === 'object' && 'id' in p);
  if (!all.some((p) => p.id === DEFAULT_PROFILE)) all.push(fallback());
  return all.sort((a, b) => (a.id === DEFAULT_PROFILE ? -1 : b.id === DEFAULT_PROFILE ? 1 : a.created - b.created));
}

export async function getProfile(id: string): Promise<Profile | null> {
  return (await run<Profile | undefined>('readonly', (s) => s.get(id))) ?? (id === DEFAULT_PROFILE ? fallback() : null);
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 40);

export async function createProfile(name: string): Promise<Profile> {
  const n = cleanName(name);
  if (!n) throw new Error('A profile needs a name');
  const profile: Profile = { id: `p${Date.now().toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`, name: n, created: Date.now(), password: false };
  await run('readwrite', (s) => s.put(profile, profile.id));
  return profile;
}

/** Changes a profile's name or password flag. */
export async function updateProfile(id: string, patch: Partial<Pick<Profile, 'name' | 'password'>>): Promise<Profile> {
  const current = await getProfile(id);
  if (!current) throw new Error(`No profile ${id}`);
  const next = { ...current, ...patch, ...(patch.name !== undefined ? { name: cleanName(patch.name) || current.name } : {}) };
  await run('readwrite', (s) => s.put(next, id));
  return next;
}

/** The profile this browser opened last. */
export async function lastProfile(): Promise<string> {
  const id = await run<string | undefined>('readonly', (s) => s.get(LAST)).catch(() => undefined);
  return id && (await getProfile(id)) ? id : DEFAULT_PROFILE;
}

export async function setLastProfile(id: string): Promise<void> {
  await run('readwrite', (s) => s.put(id, LAST));
}

const deleteDb = (name: string | null) =>
  new Promise<void>((resolve) => {
    if (!name) return resolve();
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });

/**
 * Deletes a profile with its files, settings and keys. Close its windows
 * first: a kernel still running keeps what it has in memory.
 */
export async function deleteProfile(id: string): Promise<void> {
  if (id === DEFAULT_PROFILE) throw new Error('The first profile cannot be deleted');
  if (!BOX_ID.test(id)) throw new Error(`invalid profile id: ${id}`);
  const k = profileKernel(id);
  try {
    const profiles = await (await navigator.storage.getDirectory()).getDirectoryHandle('profiles');
    await profiles.removeEntry(id, { recursive: true });
  } catch {
    /* no files yet */
  }
  await Promise.all([deleteDb(dbName('bbx-settings', k)), deleteDb(dbName('bbx-secrets', k))]);
  await run('readwrite', (s) => s.delete(id));
  if ((await run<string | undefined>('readonly', (s) => s.get(LAST)).catch(() => undefined)) === id) await setLastProfile(DEFAULT_PROFILE);
}

/** The kernel a profile runs in: the first profile is the site's original kernel. */
export const kernelOf = (id: string) => profileKernel(id === DEFAULT_PROFILE ? null : id);
