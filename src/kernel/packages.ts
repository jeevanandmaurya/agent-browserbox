import { KERNEL_URL } from '@/config/origins';
import { PACKAGE_CACHE } from '@/sandbox/python-runtime';
import type { KernelCore } from './kernel';
import { NO_PACKAGES, type PackageManifest, type PackageModule, type PackageRegistry } from './package-types';

/** What packages can provide by name: the kinds listed in a manifest that a layer above has given a type to. */
export type ProvidedKind = keyof PackageModule & ('commands' | 'tools');
type Item<K extends ProvidedKind> = NonNullable<PackageModule[K]> extends ReadonlyArray<infer T> ? T : never;

export const INSTALLED_KEY = 'pkg.installed';

export interface PackageInfo extends PackageManifest {
  installed: boolean;
  /** Download size in bytes: measured from the build and the server, or the manifest's estimate before download. */
  bytes: number;
  /** True while `bytes` includes an estimate for files not yet downloaded. */
  estimated: boolean;
}

export type Progress = (loaded: number, total: number) => void;

/**
 * The package manager. A package's files (its own build chunk plus any remote
 * runtime files) are downloaded into Cache Storage on install, so installed
 * packages work offline; its code is imported the first time one of its
 * commands or tools is used.
 */
export class PackageManager {
  #loaded = new Map<string, Promise<PackageModule>>();
  #built: Promise<Record<string, Array<{ url: string; bytes: number }>>> | null = null;

  constructor(
    private os: KernelCore,
    private registry: PackageRegistry = NO_PACKAGES,
  ) {}

  /** Every package this build knows about, installed or not. */
  manifests(): readonly PackageManifest[] {
    return this.registry.manifests;
  }

  #find(id: string): PackageManifest | undefined {
    return this.registry.manifests.find((p) => p.id === id);
  }

  /** The package that provides a shell command or an agent tool. */
  #providerOf(name: string, kind: 'commands' | 'tools'): PackageManifest | undefined {
    return this.registry.manifests.find((p) => p[kind].includes(name));
  }

  installed(): string[] {
    return this.os.settings.get<string[]>(INSTALLED_KEY, []);
  }

  isInstalled(id: string): boolean {
    return this.installed().includes(id);
  }

  /** The package's files: its build output (listed by the build in kernel/packages.json) and remote files. */
  async #files(m: PackageManifest): Promise<Array<{ url: string; bytes: number }>> {
    this.#built ??= fetch(new URL('packages.json', KERNEL_URL))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})); // development server: modules are served unbundled
    const built = ((await this.#built)[m.id] ?? []).map((f) => ({ url: new URL(`../${f.url}`, KERNEL_URL).href, bytes: f.bytes }));
    return [...built, ...(m.remote ?? []).map((url) => ({ url, bytes: 0 }))];
  }

  async list(): Promise<PackageInfo[]> {
    const cache = await caches.open(PACKAGE_CACHE).catch(() => null);
    return Promise.all(
      this.registry.manifests.map(async (m) => {
        let bytes = 0;
        let missing = false;
        for (const f of await this.#files(m)) {
          const n = f.bytes || Number((await cache?.match(f.url))?.headers.get('x-bbx-bytes')) || 0;
          if (!n) missing = true;
          bytes += n;
        }
        const estimated = missing && !!m.remoteBytes;
        return { ...m, installed: this.isInstalled(m.id), bytes: estimated ? bytes + m.remoteBytes! : bytes, estimated };
      }),
    );
  }

  async install(id: string, progress?: Progress): Promise<void> {
    const m = this.#find(id);
    if (!m) throw new Error(`no such package: ${id} (see pkg list)`);
    const files = await this.#files(m);
    const cache = await caches.open(PACKAGE_CACHE);
    let total = files.reduce((n, f) => n + f.bytes, 0);
    let loaded = 0;
    progress?.(0, total);
    for (const f of files) {
      const hit = await cache.match(f.url);
      if (hit) {
        loaded += f.bytes || Number(hit.headers.get('x-bbx-bytes')) || 0;
        total = Math.max(total, loaded);
        progress?.(loaded, total);
        continue;
      }
      const res = await fetch(f.url);
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${f.url}`);
      // Remote files' sizes are learned from the server as each one starts.
      if (!f.bytes) total += Number(res.headers.get('content-length')) || 0;
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (const reader = res.body.getReader(); ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        loaded += value.length;
        total = Math.max(total, loaded); // a compressed transfer reports the encoded length
        progress?.(loaded, total);
      }
      const headers = new Headers(res.headers);
      headers.set('x-bbx-bytes', String(got));
      headers.delete('content-encoding');
      headers.delete('content-length');
      await cache.put(f.url, new Response(new Blob(chunks as BlobPart[]), { headers }));
    }
    if (!this.isInstalled(id)) this.os.settings.set(INSTALLED_KEY, [...this.installed(), id].sort());
    this.os.log('pkg', `installed ${id} ${m.version}`);
  }

  async remove(id: string): Promise<void> {
    const m = this.#find(id);
    if (!m) throw new Error(`no such package: ${id}`);
    this.os.settings.set(
      INSTALLED_KEY,
      this.installed().filter((x) => x !== id),
    );
    this.#loaded.delete(id);
    const cache = await caches.open(PACKAGE_CACHE);
    for (const f of await this.#files(m)) await cache.delete(f.url);
    this.os.log('pkg', `removed ${id}`);
  }

  load(id: string): Promise<PackageModule> {
    if (!this.isInstalled(id)) return Promise.reject(new Error(`package ${id} is not installed. Run: pkg install ${id}`));
    let p = this.#loaded.get(id);
    if (!p) {
      p = this.registry.load(id);
      this.#loaded.set(id, p);
      p.catch(() => this.#loaded.delete(id));
    }
    return p;
  }

  /** Resolves a command or tool from an installed package. Throws a helpful error when it needs installing. */
  async provided<K extends ProvidedKind>(kind: K, name: string): Promise<Item<K> | null> {
    const m = this.#providerOf(name, kind);
    if (!m) return null;
    if (!this.isInstalled(m.id)) throw new Error(`${name}: provided by the ${m.id} package, which is not installed. Run: pkg install ${m.id}`);
    const items = (await this.load(m.id))[kind] as unknown as ReadonlyArray<Item<K> & { name: string }> | undefined;
    return items?.find((c) => c.name === name) ?? null;
  }

  /** Everything of one kind (e.g. agent tools) from installed packages. */
  async all<K extends ProvidedKind>(kind: K): Promise<Array<Item<K>>> {
    const mods = await Promise.all(this.registry.manifests.filter((m) => m[kind].length && this.isInstalled(m.id)).map((m) => this.load(m.id).catch(() => null)));
    return mods.flatMap((m) => (m?.[kind] ?? []) as unknown as ReadonlyArray<Item<K>>);
  }
}
