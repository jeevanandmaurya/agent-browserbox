import type { Bus } from './bus';
import type { KernelEvents } from './types';

const PREFIX = 'bbx:';

/**
 * Synchronous settings store on localStorage, so the first paint never waits
 * on async storage. Values are small JSON; secrets go in `Secrets` instead.
 */
export class Settings {
  #mem = new Map<string, string>();
  #ls: Storage | null;

  constructor(private bus: Bus<KernelEvents>) {
    try {
      this.#ls = globalThis.localStorage ?? null;
      this.#ls?.getItem(PREFIX);
    } catch {
      this.#ls = null; // storage blocked (private mode, sandboxed frame)
    }
  }

  get<T>(key: string, fallback: T): T {
    const raw = this.#ls ? this.#ls.getItem(PREFIX + key) : (this.#mem.get(key) ?? null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    const raw = JSON.stringify(value);
    try {
      if (this.#ls) this.#ls.setItem(PREFIX + key, raw);
      else this.#mem.set(key, raw);
    } catch {
      this.#mem.set(key, raw);
    }
    this.bus.emit('settings:change', { key, value });
  }

  delete(key: string): void {
    this.#ls?.removeItem(PREFIX + key);
    this.#mem.delete(key);
    this.bus.emit('settings:change', { key, value: undefined });
  }

  keys(): string[] {
    if (!this.#ls) return [...this.#mem.keys()];
    const out: string[] = [];
    for (let i = 0; i < this.#ls.length; i++) {
      const k = this.#ls.key(i);
      if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  }
}
