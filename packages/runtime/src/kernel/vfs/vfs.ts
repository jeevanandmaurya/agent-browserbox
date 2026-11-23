import type { Bus } from '../bus';
import type { KernelEvents } from '../types';
import { basename, dirname, globToRegExp, isInside, join, normalize } from './path';
import { FsError, type FsBackend, type Stat } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Mount {
  point: string;
  fs: FsBackend;
}

/**
 * The virtual filesystem: a mount table in front of pluggable backends.
 * Every app, shell command and agent tool goes through this single class,
 * which is what makes the sandbox boundary enforceable.
 */
export class Vfs {
  #mounts: Mount[] = [];
  #ready: Promise<void>;
  #setReady!: () => void;

  constructor(private bus: Bus<KernelEvents>) {
    this.#ready = new Promise((r) => (this.#setReady = r));
  }

  /** Resolves once the root filesystem is mounted. All operations await it. */
  get ready(): Promise<void> {
    return this.#ready;
  }
  markReady(): void {
    this.#setReady();
  }

  mount(point: string, fs: FsBackend): void {
    point = normalize(point);
    this.#mounts = this.#mounts.filter((m) => m.point !== point);
    this.#mounts.push({ point, fs });
    this.#mounts.sort((a, b) => b.point.length - a.point.length);
    this.bus.emit('fs:change', { path: point, type: 'mount' });
  }

  unmount(point: string): void {
    point = normalize(point);
    this.#mounts = this.#mounts.filter((m) => m.point !== point || m.point === '/');
    this.bus.emit('fs:change', { path: point, type: 'mount' });
  }

  mounts(): readonly Mount[] {
    return this.#mounts;
  }

  async #route(path: string): Promise<{ fs: FsBackend; rel: string; path: string }> {
    await this.#ready;
    const p = normalize(path);
    for (const m of this.#mounts) {
      if (isInside(m.point, p)) return { fs: m.fs, rel: m.point === '/' ? p : p.slice(m.point.length) || '/', path: p };
    }
    throw new FsError('ENOENT', p, 'no filesystem mounted');
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.#route(path);
    return r.fs.readFile(r.rel);
  }

  async readText(path: string): Promise<string> {
    return dec.decode(await this.readFile(path));
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const r = await this.#route(path);
    if (r.fs.readonly) throw new FsError('EACCES', r.path, 'read-only filesystem');
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    await r.fs.mkdir(dirname(r.rel));
    await r.fs.writeFile(r.rel, bytes);
    this.bus.emit('fs:change', { path: r.path, type: 'write' });
  }

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    const add = typeof data === 'string' ? enc.encode(data) : data;
    let prev: Uint8Array = new Uint8Array();
    try {
      prev = await this.readFile(path);
    } catch (err) {
      if (!(err instanceof FsError && err.code === 'ENOENT')) throw err;
    }
    const out = new Uint8Array(prev.length + add.length);
    out.set(prev);
    out.set(add, prev.length);
    await this.writeFile(path, out);
  }

  async readdir(path: string): Promise<Stat[]> {
    const r = await this.#route(path);
    const list = (await r.fs.readdir(r.rel)).map((s) => ({ ...s, path: join(r.path, s.name) }));
    // Surface mount points that live directly inside this directory.
    for (const m of this.#mounts) {
      if (m.point !== '/' && dirname(m.point) === r.path && !list.some((s) => s.name === basename(m.point))) {
        list.push({ path: m.point, name: basename(m.point), kind: 'dir', size: 0, mtime: 0 });
      }
    }
    return list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  async stat(path: string): Promise<Stat | null> {
    const p = normalize(path);
    await this.#ready;
    if (this.#mounts.some((m) => m.point === p)) return { path: p, name: basename(p), kind: 'dir', size: 0, mtime: 0 };
    const r = await this.#route(p);
    const s = await r.fs.stat(r.rel);
    return s ? { ...s, path: r.path, name: basename(r.path) } : null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path).catch(() => null)) !== null;
  }

  async mkdir(path: string): Promise<void> {
    const r = await this.#route(path);
    if (r.fs.readonly) throw new FsError('EACCES', r.path, 'read-only filesystem');
    await r.fs.mkdir(r.rel);
    this.bus.emit('fs:change', { path: r.path, type: 'mkdir' });
  }

  async rm(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const r = await this.#route(path);
    if (r.fs.readonly) throw new FsError('EACCES', r.path, 'read-only filesystem');
    if (this.#mounts.some((m) => m.point === r.path)) throw new FsError('EACCES', r.path, 'is a mount point');
    await r.fs.remove(r.rel, opts.recursive ?? false);
    this.bus.emit('fs:change', { path: r.path, type: 'remove' });
  }

  async cp(from: string, to: string): Promise<void> {
    const s = await this.stat(from);
    if (!s) throw new FsError('ENOENT', from);
    if (s.kind === 'file') return this.writeFile(to, await this.readFile(from));
    if (isInside(from, to)) throw new FsError('EACCES', to, 'cannot copy a directory into itself');
    await this.mkdir(to);
    for (const child of await this.readdir(from)) await this.cp(child.path, join(to, child.name));
  }

  async mv(from: string, to: string): Promise<void> {
    if (normalize(from) === normalize(to)) return;
    await this.cp(from, to);
    await this.rm(from, { recursive: true });
  }

  /** Depth-first walk. Skips unreadable directories instead of failing. */
  async *walk(root: string, opts: { maxDepth?: number; signal?: AbortSignal } = {}): AsyncGenerator<Stat> {
    const stack: Array<[string, number]> = [[normalize(root), 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop()!;
      opts.signal?.throwIfAborted();
      let entries: Stat[];
      try {
        entries = await this.readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        yield e;
        if (e.kind === 'dir' && depth + 1 < (opts.maxDepth ?? 32) && e.path !== '/proc') stack.push([e.path, depth + 1]);
      }
    }
  }

  async glob(pattern: string, cwd = '/', limit = 2000): Promise<string[]> {
    const abs = pattern.startsWith('/') ? pattern : join(cwd, pattern).replace(/\/$/, '');
    const firstWild = abs.search(/[*?{]/);
    if (firstWild < 0) return (await this.exists(abs)) ? [normalize(abs)] : [];
    const base = dirname(abs.slice(0, firstWild) + 'x');
    const re = globToRegExp(abs);
    const out: string[] = [];
    for await (const s of this.walk(base)) {
      if (re.test(s.path)) out.push(s.path);
      if (out.length >= limit) break;
    }
    return out.sort();
  }
}

export { FsError, type FsBackend, type Stat };
