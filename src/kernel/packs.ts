import { DEFAULT_PACKS, PACKS, PACKS_KEY } from '@/agent/packs';
import { KERNEL_URL } from '@/config/origins';
import { PACK_CACHE, PYODIDE_URL, PYTHON_RUNTIME_FILES } from '@/sandbox/sandbox';
import type { KernelCore } from './kernel';

/** What a window needs to show a tool pack honestly: whether it is on, downloaded, and how big it really is. */
export interface PackState {
  id: string;
  name: string;
  description: string;
  available: boolean;
  /** The user wants this pack (its commands are enabled). */
  selected: boolean;
  /** Its files are stored on this device. */
  cached: boolean;
  /** Total download size in bytes; 0 when not yet known. */
  bytes: number;
  /** Bytes downloaded so far while `downloading`. */
  loaded: number;
  downloading: boolean;
  error?: string;
}

export interface PacksApi {
  list(): Promise<PackState[]>;
  /** Enables the pack and downloads its files, reporting progress through `pack:change` events. */
  install(id: string): Promise<void>;
  /** Disables the pack and deletes its downloaded files. */
  remove(id: string): Promise<void>;
}

interface FileRef {
  url: string;
  bytes: number;
  cache: string;
}

/**
 * Tool packs: optional runtimes whose code is downloaded on request rather
 * than shipped with the app. Files go into Cache Storage, so an installed
 * pack works offline and its download is measured, not guessed.
 */
export class PackManager implements PacksApi {
  #live = new Map<string, { loaded: number; bytes: number; error?: string; done: Promise<void> }>();
  #manifest: Promise<Record<string, Array<{ url: string; bytes: number }>>> | null = null;

  constructor(private os: KernelCore) {}

  #selected(): string[] {
    return this.os.settings.get<string[]>(PACKS_KEY, DEFAULT_PACKS);
  }

  /** Files of each pack. Absent in development builds, where modules are served unbundled. */
  #files(id: string): Promise<FileRef[]> {
    if (id === 'python') return Promise.resolve(PYTHON_RUNTIME_FILES.map((f) => ({ url: PYODIDE_URL + f, bytes: 0, cache: PACK_CACHE })));
    this.#manifest ??= fetch(new URL('packs.json', KERNEL_URL))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    return this.#manifest.then((m) => (m[id] ?? []).map((f) => ({ url: new URL(`../${f.url}`, KERNEL_URL).href, bytes: f.bytes, cache: PACK_CACHE })));
  }

  async #state(id: string): Promise<PackState> {
    const pack = PACKS.find((p) => p.id === id)!;
    const files = await this.#files(id);
    const live = this.#live.get(id);
    let cached = files.length > 0;
    let bytes = files.reduce((n, f) => n + f.bytes, 0);
    try {
      let measured = 0;
      for (const f of files) {
        const hit = await (await caches.open(f.cache)).match(f.url);
        if (!hit) cached = false;
        else if (!f.bytes) measured += Number(hit.headers.get('x-bbx-bytes')) || 0;
      }
      bytes ||= measured;
    } catch {
      cached = false;
    }
    // With no manifest (development) the code is simply imported on first use.
    if (!files.length && pack.available) cached = true;
    return { id, name: pack.name, description: pack.description, available: pack.available, selected: this.#selected().includes(id), cached, bytes: live?.bytes || bytes, loaded: live?.loaded ?? 0, downloading: live !== undefined && !live.error, error: live?.error };
  }

  list(): Promise<PackState[]> {
    return Promise.all(PACKS.map((p) => this.#state(p.id)));
  }

  async #announce(id: string): Promise<void> {
    this.os.bus.emit('pack:change', await this.#state(id));
  }

  async install(id: string, onProgress?: (loaded: number, bytes: number) => void): Promise<void> {
    const pack = PACKS.find((p) => p.id === id);
    if (!pack) throw new Error(`no such pack: ${id}`);
    if (!pack.available) throw new Error(`${pack.name} is planned but not available yet`);
    if (!this.#selected().includes(id)) this.os.settings.set(PACKS_KEY, [...this.#selected(), id]);
    const running = this.#live.get(id);
    if (running && !running.error) return running.done;

    const live = { loaded: 0, bytes: 0, done: Promise.resolve() as Promise<void>, error: undefined as string | undefined };
    this.#live.set(id, live);
    live.done = (async () => {
      const files = await this.#files(id);
      live.bytes = files.reduce((n, f) => n + f.bytes, 0);
      let last = 0;
      const tick = (force = false) => {
        onProgress?.(live.loaded, live.bytes);
        if (force || performance.now() - last > 120) {
          last = performance.now();
          void this.#announce(id);
        }
      };
      tick(true);
      for (const f of files) {
        const cache = await caches.open(f.cache);
        if (await cache.match(f.url)) {
          live.loaded += f.bytes;
          continue;
        }
        const res = await fetch(f.url);
        if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}) for ${f.url.split('/').pop()}`);
        // Sizes we could not know in advance are learned from the server as each file starts.
        if (!f.bytes) live.bytes += Number(res.headers.get('content-length')) || 0;
        const chunks: Uint8Array[] = [];
        let got = 0;
        for (const reader = res.body.getReader(); ; ) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          live.loaded += value.length;
          if (live.loaded > live.bytes) live.bytes = live.loaded; // compressed transfer: length was the encoded size
          tick();
        }
        const headers = new Headers(res.headers);
        headers.set('x-bbx-bytes', String(got));
        headers.delete('content-encoding');
        headers.delete('content-length');
        await cache.put(f.url, new Response(new Blob(chunks as BlobPart[]), { headers }));
      }
    })().then(
      () => {
        this.#live.delete(id);
        return this.#announce(id);
      },
      (err: Error) => {
        live.error = err.message;
        void this.#announce(id);
        throw err;
      },
    );
    return live.done;
  }

  /** Downloads a selected pack that is not on this device yet, so first use is cached and visible. */
  async ensure(id: string, onProgress?: (loaded: number, bytes: number) => void): Promise<void> {
    const s = await this.#state(id);
    if (s.selected && !s.cached) await this.install(id, onProgress);
  }

  async remove(id: string): Promise<void> {
    this.os.settings.set(
      PACKS_KEY,
      this.#selected().filter((p) => p !== id),
    );
    this.#live.delete(id);
    for (const f of await this.#files(id)) await (await caches.open(f.cache)).delete(f.url).catch(() => false);
    await this.#announce(id);
  }
}
