import type { Bus } from './bus';
import type { KernelEvents } from './types';

/**
 * Settings: small JSON values, readable synchronously from an in-memory map.
 * The kernel persists them (IndexedDB); each window holds a replica that is
 * hydrated on connect and kept current by change events.
 */
export class Settings {
  #values = new Map<string, unknown>();

  constructor(
    private bus: Bus<KernelEvents>,
    /** Called for local writes: the kernel persists, a window forwards to the kernel. */
    private onWrite?: (key: string, value: unknown) => void,
  ) {}

  /** Replaces all values without firing per-key writes. */
  hydrate(entries: Array<[string, unknown]>): void {
    this.#values = new Map(entries);
    for (const [key, value] of entries) this.bus.emit('settings:change', { key, value });
  }

  entries(): Array<[string, unknown]> {
    return [...this.#values];
  }

  get<T>(key: string, fallback: T): T {
    return this.#values.has(key) ? (this.#values.get(key) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.applyRemote(key, value);
    this.onWrite?.(key, value);
  }

  delete(key: string): void {
    this.set(key, undefined);
  }

  /** Applies a change that originated elsewhere (no write-back). */
  applyRemote(key: string, value: unknown): void {
    if (value === undefined) this.#values.delete(key);
    else this.#values.set(key, value);
    this.bus.emit('settings:change', { key, value });
  }

  keys(): string[] {
    return [...this.#values.keys()];
  }
}

// ---- Persistence (kernel side) ------------------------------------------------

export const SETTINGS_DB = 'bbx-settings';
const STORE = 'kv';

function open(db: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** `db` null: nothing is stored (an in-memory box). */
export async function loadSettings(dbName: string | null = SETTINGS_DB): Promise<Array<[string, unknown]>> {
  if (dbName === null) return [];
  try {
    const db = await open(dbName);
    return await new Promise((resolve, reject) => {
      const out: Array<[string, unknown]> = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push([String(c.key), c.value]);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return []; // storage unavailable: settings last for this session only
  }
}

export async function persistSetting(key: string, value: unknown, dbName: string | null = SETTINGS_DB): Promise<void> {
  if (dbName === null) return;
  try {
    const store = (await open(dbName)).transaction(STORE, 'readwrite').objectStore(STORE);
    if (value === undefined) store.delete(key);
    else store.put(value, key);
  } catch {
    /* not persisted */
  }
}
