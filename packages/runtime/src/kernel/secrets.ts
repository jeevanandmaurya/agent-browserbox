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

/**
 * With a password the data key is wrapped by a key derived from the password
 * (`#wrapped`) and, while the profile is signed in, kept unwrapped but still
 * non-extractable (`#session`). Signing out deletes `#session`: the keys stay
 * encrypted and unusable until the password is entered again. Without a
 * password the data key is `#master`. The agent package reads the same scheme.
 */
import type { LockState } from './types';
export type { LockState };
export class SecretsLockedError extends Error {
  constructor() {
    super('This profile is signed out: its API keys are locked until you sign in.');
    this.name = 'SecretsLockedError';
  }
}

interface Wrapped {
  salt: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  iterations: number;
  wrapped: ArrayBuffer;
}
type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

const ITERATIONS = 310_000;

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

function all(db: IDBDatabase): Promise<Array<[string, unknown]>> {
  return new Promise((resolve, reject) => {
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
}

/** Puts and deletes in one transaction, so a re-encryption is all or nothing. */
function commit(db: IDBDatabase, puts: Array<[string, unknown]>, deletes: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    for (const [k, v] of puts) s.put(v, k);
    for (const k of deletes) s.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class Secrets {
  #db: Promise<IDBDatabase> | null = null;
  #mem = new Map<string, string>();

  /** `dbName` null: secrets are kept in memory only (an in-memory box). */
  constructor(private dbName: string | null = SECRETS_DB) {}

  #open(): Promise<IDBDatabase> {
    return (this.#db ??= open(this.dbName));
  }

  async #key(db: IDBDatabase): Promise<CryptoKey> {
    const session = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('#session'));
    if (session) return session;
    if (await tx<Wrapped | undefined>(db, 'readonly', (s) => s.get('#wrapped'))) throw new SecretsLockedError();
    const existing = await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('#master'));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await tx(db, 'readwrite', (s) => s.put(key, '#master'));
    return key;
  }

  /** 'open': no password. 'locked': signed out. 'unlocked': signed in. */
  async status(): Promise<LockState> {
    if (this.dbName === null) return 'open';
    const db = await this.#open();
    if (!(await tx<Wrapped | undefined>(db, 'readonly', (s) => s.get('#wrapped')))) return 'open';
    return (await tx<CryptoKey | undefined>(db, 'readonly', (s) => s.get('#session'))) ? 'unlocked' : 'locked';
  }

  /** Signs in: true when the password is right. */
  async unlock(password: string): Promise<boolean> {
    const db = await this.#open();
    const w = await tx<Wrapped | undefined>(db, 'readonly', (s) => s.get('#wrapped'));
    if (!w) return true;
    try {
      const session = await crypto.subtle.unwrapKey('raw', w.wrapped, await passwordKey(password, w.salt, w.iterations), { name: 'AES-GCM', iv: w.iv }, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      await tx(db, 'readwrite', (s) => s.put(session, '#session'));
      return true;
    } catch {
      return false;
    }
  }

  /** Signs out: the keys stay encrypted until the next unlock. */
  async lock(): Promise<void> {
    if (this.dbName === null) return;
    await tx(await this.#open(), 'readwrite', (s) => s.delete('#session'));
  }

  /**
   * Sets, changes (`null` removes) the password. Needs the keys unlocked; every
   * saved key is re-encrypted under a new data key in one transaction.
   */
  async setPassword(password: string | null): Promise<void> {
    if (this.dbName === null) throw new Error('an in-memory box has no password');
    const db = await this.#open();
    const current = await this.#key(db);
    const plain: Array<[string, Uint8Array]> = [];
    for (const [k, v] of await all(db)) {
      if (k.startsWith('#')) continue;
      const rec = v as Sealed;
      plain.push([k, new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, current, rec.data))]);
    }
    let key: CryptoKey;
    const puts: Array<[string, unknown]> = [];
    let deletes: string[];
    if (password) {
      const raw = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const kek = await passwordKey(password, salt, ITERATIONS);
      const wrapped = await crypto.subtle.wrapKey('raw', raw, kek, { name: 'AES-GCM', iv });
      // Kept and used non-extractable, like #master.
      key = await crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-GCM', iv }, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      puts.push(['#wrapped', { salt, iv, iterations: ITERATIONS, wrapped } satisfies Wrapped], ['#session', key]);
      deletes = ['#master'];
    } else {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      puts.push(['#master', key]);
      deletes = ['#wrapped', '#session'];
    }
    for (const [k, bytes] of plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      puts.push([k, { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes as Uint8Array<ArrayBuffer>) } satisfies Sealed]);
    }
    await commit(db, puts, deletes);
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
