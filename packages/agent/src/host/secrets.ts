import type { SecretsApi } from './os.js';
/**
 * Secret storage (API keys). Values are encrypted with AES-GCM under a
 * non-extractable CryptoKey that lives in IndexedDB: page scripts can use the
 * key but can never read its bytes, and the ciphertext is useless elsewhere.
 * Sandboxed agent code runs in an opaque origin and cannot reach this store.
 */
export const SECRETS_DB = 'bbx-secrets';
const STORE = 'kv';

function open(db: string | null): Promise<IDBDatabase> {
  if (db === null) return Promise.reject(new Error('in-memory'));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The profile is signed out: its keys stay encrypted until the user signs in again. */
export class SecretsLockedError extends Error {
  constructor() {
    super('This profile is signed out: its API keys are locked until you sign in.');
    this.name = 'SecretsLockedError';
  }
}

/**
 * API keys kept encrypted in this origin's IndexedDB, under a non-extractable
 * key: the same store (and scheme) BrowserBox's kernel uses, so an app on the
 * same site sees the keys its users already saved. Works in pages and workers.
 */
export class BrowserSecrets implements SecretsApi {
  #db: Promise<IDBDatabase> | null = null;
  #mem = new Map<string, string>();

  /** `dbName` null: secrets are kept in memory only (an in-memory box). */
  constructor(private dbName: string | null = SECRETS_DB) {}


  #open(): Promise<IDBDatabase> {
    return (this.#db ??= open(this.dbName));
  }

  async #key(db: IDBDatabase): Promise<CryptoKey> {
    // A profile with a password: usable only while signed in (see the runtime's key store).
    const session = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('#session'));
    if (session) return session;
    if (await tx<unknown>(db, 'readonly', (s) => s.get('#wrapped'))) throw new SecretsLockedError();
    const existing = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('#master'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await tx(db, 'readwrite', (s) => s.put(key, '#master'));
    return key;
  }

  async get(name: string): Promise<string | null> {
    try {
      const db = await this.#open();
      const rec = await tx<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>(db, 'readonly', (s) => s.get(name));
      if (!rec) return this.#mem.get(name) ?? null;
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, await this.#key(db), rec.data);
      return new TextDecoder().decode(plain);
    } catch (err) {
      if (err instanceof SecretsLockedError) throw err;
      return this.#mem.get(name) ?? null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (!value) return this.delete(name);
    try {
      const db = await this.#open();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#key(db), new TextEncoder().encode(value));
      await tx(db, 'readwrite', (s) => s.put({ iv, data }, name));
    } catch (err) {
      if (err instanceof SecretsLockedError) throw err;
      this.#mem.set(name, value); // IndexedDB unavailable: keep for this session only
    }
  }

  async delete(name: string): Promise<void> {
    this.#mem.delete(name);
    try {
      await tx(await this.#open(), 'readwrite', (s) => s.delete(name));
    } catch {
      /* nothing stored */
    }
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }
}
