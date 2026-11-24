import { KERNEL_URL } from '../config/origins';
import { PACKAGE_CACHE } from '../sandbox/python-runtime';
import type { KernelCore } from './kernel';
import { NO_PACKAGES, type ExternalKind, type ExternalPackage, type InstalledExternal, type Listed, type PackageCommand, type PackageFile, type PackageInfo, type PackageManifest, type PackageModule, type PackageRegistry, type PackageSource } from './package-types';
export type { ExternalKind, ExternalPackage, InstalledExternal, Listed, PackageCommand, PackageFile, PackageInfo, PackageSource };

/** What packages can provide by name: the kinds listed in a manifest that a layer above has given a type to. */
export type ProvidedKind = keyof PackageModule & ('commands' | 'tools');
type Item<K extends ProvidedKind> = NonNullable<PackageModule[K]> extends ReadonlyArray<infer T> ? T : never;

export const INSTALLED_KEY = 'pkg.installed';
/** Packages installed from a source (wasm, js, script): records by id. */
export const EXTERNAL_KEY = 'pkg.external';
/** Sources the user added (the BrowserBox index is always first). */
export const SOURCES_KEY = 'pkg.sources';
const INDEX_CACHE = 'bbx-pkg-index';


const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CMD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Checks a package description; throws with what is wrong. */
export function validatePackage(p: unknown): ExternalPackage {
  const x = p as ExternalPackage;
  const bad = (why: string): never => {
    throw new Error(`invalid package${x && typeof x.id === 'string' ? ` ${x.id}` : ''}: ${why}`);
  };
  if (!x || typeof x !== 'object') bad('not an object');
  if (typeof x.id !== 'string' || !ID.test(x.id)) bad('id must be lowercase letters, digits, . _ -');
  if (typeof x.version !== 'string' || !x.version) bad('no version');
  if (!['wasm', 'js', 'script'].includes(x.kind)) bad('kind must be wasm, js or script');
  if (!Array.isArray(x.files) || !x.files.length) bad('no files');
  for (const f of x.files) {
    if (typeof f?.path !== 'string' || !f.path || f.path.includes('..') || f.path.startsWith('/')) bad(`file path ${f?.path}`);
    if (typeof f.text === 'string') {
      if (f.url !== undefined) bad(`file ${f.path} has both url and text`);
    } else if (typeof f.url !== 'string' || !/^https?:\/\//.test(f.url)) bad(`file url ${f.url}`);
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) bad(`file ${f.path} needs a sha256`);
  }
  if (!x.commands || typeof x.commands !== 'object' || !Object.keys(x.commands).length) bad('no commands');
  for (const [name, c] of Object.entries(x.commands)) {
    if (!CMD.test(name)) bad(`command name ${name}`);
    if (!x.files.some((f) => f.path === c?.run)) bad(`command ${name} runs ${c?.run}, which is not one of its files`);
    if (c.load !== undefined) {
      if (x.kind !== 'js') bad(`command ${name}: only JavaScript packages load files`);
      if (!Array.isArray(c.load) || c.load.some((l) => !x.files.some((f) => f.path === l))) bad(`command ${name} loads a file that is not one of its files`);
    }
    if (c.assets !== undefined) {
      if (x.kind !== 'js') bad(`command ${name}: only JavaScript packages have assets`);
      if (!Array.isArray(c.assets) || c.assets.some((l) => !x.files.some((f) => f.path === l))) bad(`command ${name} has an asset that is not one of its files`);
    }
  }
  return { ...x, summary: typeof x.summary === 'string' ? x.summary : '', depends: Array.isArray(x.depends) ? x.depends.filter((d) => typeof d === 'string') : [] };
}

/**
 * A JavaScript program with libraries: each library runs once with its own
 * `module`/`exports` (so UMD and CommonJS builds export there), and the entry
 * gets them with `require(path)`.
 */
export function bundleJs(libs: ReadonlyArray<readonly [string, string]>, entry: string): string {
  const parts = libs.map(
    ([path, code]) =>
      `{ const module = { exports: {} }; (function (module, exports, define, self, window) {\n${code}\n}).call(globalThis, module, module.exports, undefined, globalThis, globalThis); __libs[${JSON.stringify(path)}] = module.exports; }`,
  );
  // \`require\` exists (undefined) while the libraries run: many check \`typeof require\`, which must not throw.
  return `const __libs = {};\nlet require;\n${parts.join('\n')}\nrequire = (p) => { const m = __libs[p] ?? __libs[String(p).replace(/^\\.\\//, '')]; if (m === undefined) throw new Error('cannot require ' + p); return m; };\n${entry}`;
}

/** Compares dotted versions numerically (1.10 > 1.9); non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    const c = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (c) return Math.sign(c);
  }
  return 0;
}

/** `id` or `id>=1.2` → its parts. */
export const parseDep = (d: string) => {
  const m = /^([a-z0-9][a-z0-9._-]*)\s*(?:>=\s*(\S+))?$/.exec(d.trim());
  return m ? { id: m[1]!, min: m[2] } : null;
};

export async function sha256(data: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    return this.installed().includes(id) || id in this.externals();
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
    if (!m) {
      // Not built in: a package from a source (`id` or `id@version`).
      const [name, version] = id.split('@') as [string, string | undefined];
      const found = await this.find(name, { version });
      if (!found) throw new Error(`no such package: ${id} (see pkg search)`);
      await this.installExternal(found, found.source, progress);
      return;
    }
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

  async remove(id: string, o: { force?: boolean } = {}): Promise<void> {
    const m = this.#find(id);
    if (!m) return this.removeExternal(id, o);
    this.os.settings.set(
      INSTALLED_KEY,
      this.installed().filter((x) => x !== id),
    );
    this.#loaded.delete(id);
    const cache = await caches.open(PACKAGE_CACHE);
    for (const f of await this.#files(m)) await cache.delete(f.url);
    this.os.log('pkg', `removed ${id}`);
  }

  // ---- packages from sources (wasm, js, script) ------------------------------------

  /** Where packages come from: the BrowserBox index first, then the ones the user added. */
  sources(): PackageSource[] {
    const added = this.os.settings.get<PackageSource[]>(SOURCES_KEY, []).filter((x) => typeof x?.url === 'string');
    return [{ url: new URL('package-index.json', KERNEL_URL).href, official: true }, ...added.map((x) => ({ url: x.url }))];
  }

  addSource(url: string): void {
    const u = new URL(url).href;
    if (this.sources().some((x) => x.url === u)) return;
    this.os.settings.set(SOURCES_KEY, [...this.os.settings.get<PackageSource[]>(SOURCES_KEY, []), { url: u }]);
    this.#index = null;
  }

  removeSource(url: string): void {
    this.os.settings.set(
      SOURCES_KEY,
      this.os.settings.get<PackageSource[]>(SOURCES_KEY, []).filter((x) => x.url !== url),
    );
    this.#index = null;
  }

  #index: Promise<Listed[]> | null = null;

  /** Every package in every source. Indexes are cached (offline too) until `update`. */
  index(refresh = false): Promise<Listed[]> {
    if (refresh || !this.#index) this.#index = this.#readIndexes(refresh);
    return this.#index;
  }

  async #readIndexes(refresh: boolean): Promise<Listed[]> {
    const cache = await caches.open(INDEX_CACHE).catch(() => null);
    const out: Listed[] = [];
    for (const src of this.sources()) {
      let body: unknown = null;
      const cached = refresh ? undefined : await cache?.match(src.url);
      try {
        if (cached) body = await cached.json();
        else {
          const res = await fetch(src.url, { cache: 'no-cache' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = await res.json();
          await cache?.put(src.url, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
        }
      } catch (err) {
        // Unreachable: keep what was cached before, if anything.
        const old = await cache?.match(src.url);
        body = old ? await old.json().catch(() => null) : null;
        if (!body) this.os.log('pkg', `source ${src.url} unavailable: ${(err as Error).message}`);
      }
      const list = (body as { packages?: unknown[] } | null)?.packages ?? [];
      for (const p of list) {
        try {
          out.push({ ...validatePackage(p), source: src.url, official: !!src.official });
        } catch (err) {
          this.os.log('pkg', `${src.url}: ${(err as Error).message}`);
        }
      }
    }
    return out;
  }

  externals(): Record<string, InstalledExternal> {
    return this.os.settings.get<Record<string, InstalledExternal>>(EXTERNAL_KEY, {});
  }

  /** The newest version of `id` in the indexes (at least `min`), or that exact `version`. */
  async find(id: string, o: { version?: string; min?: string } = {}): Promise<Listed | null> {
    const all = (await this.index()).filter((p) => p.id === id && (!o.version || p.version === o.version) && (!o.min || compareVersions(p.version, o.min) >= 0));
    return all.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
  }

  /**
   * Installs a package from a source, after its dependencies. Every file is
   * checked against its sha256 before it is kept; a mismatch fails the install.
   */
  async installExternal(pkg: ExternalPackage, source: string, progress?: Progress, seen = new Set<string>()): Promise<string[]> {
    if (seen.has(pkg.id)) return [];
    seen.add(pkg.id);
    const done: string[] = [];
    for (const d of pkg.depends ?? []) {
      const dep = parseDep(d);
      if (!dep) throw new Error(`${pkg.id}: bad dependency "${d}"`);
      if (this.#find(dep.id)) {
        if (!this.isInstalled(dep.id)) await this.install(dep.id, progress);
        continue;
      }
      const have = this.externals()[dep.id];
      if (have && (!dep.min || compareVersions(have.pkg.version, dep.min) >= 0)) continue;
      const found = await this.find(dep.id, { min: dep.min });
      if (!found) throw new Error(`${pkg.id} needs ${d}, which no source has`);
      done.push(...(await this.installExternal(found, found.source, progress, seen)));
    }
    const cache = await caches.open(PACKAGE_CACHE);
    // Only downloaded files count (a wrapper kept in the index is not fetched).
    const total = pkg.files.reduce((n, f) => n + (f.url ? (f.bytes ?? 0) : 0), 0);
    let loaded = 0;
    progress?.(0, total);
    for (const f of pkg.files) {
      if (f.url === undefined) {
        // Kept in the record itself: only its checksum to check.
        if ((await sha256(new TextEncoder().encode(f.text ?? ''))) !== f.sha256) throw new Error(`${pkg.id}: ${f.path} does not match its sha256. Not installed.`);
        continue;
      }
      const hit = await cache.match(f.url);
      if (hit && (await sha256(new Uint8Array(await hit.clone().arrayBuffer()))) === f.sha256) {
        loaded += f.bytes ?? 0;
        progress?.(loaded, Math.max(total, loaded));
        continue;
      }
      const res = await fetch(f.url);
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status}): ${f.url}`);
      const chunks: Uint8Array[] = [];
      for (const reader = res.body.getReader(); ; ) {
        const { value, done: end } = await reader.read();
        if (end) break;
        chunks.push(value);
        loaded += value.length;
        progress?.(loaded, Math.max(total, loaded));
      }
      const data = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
      const got = await sha256(data);
      if (got !== f.sha256) throw new Error(`${pkg.id}: ${f.path} does not match its sha256 (expected ${f.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…). Not installed.`);
      await cache.put(f.url, new Response(data, { headers: { 'x-bbx-bytes': String(data.length), 'x-bbx-sha256': got } }));
    }
    this.os.settings.set(EXTERNAL_KEY, { ...this.externals(), [pkg.id]: { pkg, source, installedAt: Date.now() } });
    this.os.log('pkg', `installed ${pkg.id} ${pkg.version} (${pkg.kind}) from ${source}`);
    return [...done, pkg.id];
  }

  /** Installed packages that depend on `id`. */
  dependents(id: string): string[] {
    return Object.values(this.externals())
      .filter((r) => (r.pkg.depends ?? []).some((d) => parseDep(d)?.id === id))
      .map((r) => r.pkg.id);
  }

  async removeExternal(id: string, o: { force?: boolean } = {}): Promise<void> {
    const rec = this.externals()[id];
    if (!rec) throw new Error(`${id} is not installed`);
    const users = this.dependents(id);
    if (users.length && !o.force) throw new Error(`${users.join(', ')} ${users.length > 1 ? 'need' : 'needs'} ${id}. Remove ${users.length > 1 ? 'them' : 'it'} first, or use --force.`);
    const rest = { ...this.externals() };
    delete rest[id];
    this.os.settings.set(EXTERNAL_KEY, rest);
    const cache = await caches.open(PACKAGE_CACHE);
    // Keep a file another installed package still uses.
    const used = new Set(Object.values(rest).flatMap((r) => r.pkg.files.map((f) => f.url)));
    for (const f of rec.pkg.files) if (f.url && !used.has(f.url)) await cache.delete(f.url);
    this.os.log('pkg', `removed ${id}`);
  }

  /** Installed packages with a newer version in their source. */
  async upgradable(): Promise<Array<{ id: string; from: string; to: Listed }>> {
    const out: Array<{ id: string; from: string; to: Listed }> = [];
    for (const r of Object.values(this.externals())) {
      const newest = await this.find(r.pkg.id);
      if (newest && compareVersions(newest.version, r.pkg.version) > 0) out.push({ id: r.pkg.id, from: r.pkg.version, to: newest });
    }
    return out;
  }

  /** Re-checks the cached files of installed packages; returns the ones that are missing or changed. */
  async verify(ids?: string[]): Promise<Array<{ id: string; path: string; problem: 'missing' | 'changed' }>> {
    const cache = await caches.open(PACKAGE_CACHE);
    const bad: Array<{ id: string; path: string; problem: 'missing' | 'changed' }> = [];
    for (const r of Object.values(this.externals())) {
      if (ids?.length && !ids.includes(r.pkg.id)) continue;
      for (const f of r.pkg.files) {
        if (f.url === undefined) {
          if ((await sha256(new TextEncoder().encode(f.text ?? ''))) !== f.sha256) bad.push({ id: r.pkg.id, path: f.path, problem: 'changed' });
          continue;
        }
        const hit = await cache.match(f.url);
        if (!hit) bad.push({ id: r.pkg.id, path: f.path, problem: 'missing' });
        else if ((await sha256(new Uint8Array(await hit.arrayBuffer()))) !== f.sha256) bad.push({ id: r.pkg.id, path: f.path, problem: 'changed' });
      }
    }
    return bad;
  }

  /** An installed package's command: what runs it, and its file's bytes (a JavaScript entry with its libraries loaded first). */
  externalCommand(name: string): { pkg: ExternalPackage; entry: PackageCommand; file(): Promise<Uint8Array>; assets(): Promise<Record<string, Uint8Array>> } | null {
    for (const r of Object.values(this.externals())) {
      const entry = r.pkg.commands[name];
      if (!entry) continue;
      const read = async (path: string): Promise<Uint8Array> => {
        const f = r.pkg.files.find((x) => x.path === path);
        if (!f) throw new Error(`${r.pkg.id}: no file ${path}`);
        if (f.url === undefined) return new TextEncoder().encode(f.text ?? '');
        const hit = await (await caches.open(PACKAGE_CACHE)).match(f.url);
        if (!hit) throw new Error(`${r.pkg.id}: ${f.path} is missing from the cache. Run: pkg install ${r.pkg.id}`);
        return new Uint8Array(await hit.arrayBuffer());
      };
      return {
        pkg: r.pkg,
        entry,
        file: async () => {
          if (!entry.load?.length) return read(entry.run);
          const dec = new TextDecoder();
          const libs = await Promise.all(entry.load.map(async (path) => [path, dec.decode(await read(path))] as const));
          return new TextEncoder().encode(bundleJs(libs, dec.decode(await read(entry.run))));
        },
        assets: async () => Object.fromEntries(await Promise.all((entry.assets ?? []).map(async (path) => [path, await read(path)] as const))),
      };
    }
    return null;
  }

  /** Every command installed packages from sources provide. */
  externalCommands(): string[] {
    return Object.values(this.externals()).flatMap((r) => Object.keys(r.pkg.commands));
  }

  /** The package in any source that provides a command, for "not installed" hints. */
  async providerInIndex(name: string): Promise<Listed | null> {
    return (await this.index().catch(() => [])).find((p) => name in p.commands) ?? null;
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
