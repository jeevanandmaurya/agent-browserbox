import { dirname, isInside, join } from './path';
import { FsError, type FsBackend, type Stat } from './types';

/** The parts of the VFS an overlay reads and writes its layers through. */
export interface LayerFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<Stat[]>;
  stat(path: string): Promise<Stat | null>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** A file an overlay changed, by its path inside the overlay. */
export interface OverlayChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
}

interface Meta {
  /** Paths deleted from the lower folder (a folder hides everything in it). */
  deleted: string[];
  /** Folders deleted and made again: nothing of the lower folder shows through them. */
  opaque: string[];
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A copy-on-write view of a folder: reads fall through to `lower`, every
 * change lands in `store` (files under `store/tree`, deletions in
 * `store/meta.json`), so the folder itself is untouched until the changes are
 * applied, or thrown away. This is how a chat works on its own copy of a
 * project without copying it.
 */
export class OverlayFs implements FsBackend {
  readonly label: string;
  #meta: Meta | null = null;
  #loading: Promise<Meta> | null = null;

  constructor(
    private fs: LayerFs,
    readonly lower: string,
    readonly store: string,
  ) {
    this.label = `overlay:${lower}`;
  }

  #upper = (p: string) => (p === '/' ? `${this.store}/tree` : `${this.store}/tree${p}`);
  #lower = (p: string) => (p === '/' ? this.lower : `${this.lower}${p}`);

  async #load(): Promise<Meta> {
    if (this.#meta) return this.#meta;
    this.#loading ??= this.fs
      .readFile(`${this.store}/meta.json`)
      .then((b) => JSON.parse(new TextDecoder().decode(b)) as Meta)
      .catch(() => ({ deleted: [], opaque: [] }))
      .then((m) => (this.#meta = { deleted: m.deleted ?? [], opaque: m.opaque ?? [] }));
    return this.#loading;
  }

  async #save(): Promise<void> {
    await this.fs.writeFile(`${this.store}/meta.json`, JSON.stringify(this.#meta));
  }

  /** The lower folder's copy of `p` is hidden (deleted here, or under a folder made again). */
  async #hidden(p: string): Promise<boolean> {
    const m = await this.#load();
    // The store itself, when it is kept inside the folder, never shows through.
    if (isInside(this.lower, this.store) && isInside(this.store.slice(this.lower.length) || '/', p)) return true;
    return m.deleted.some((d) => isInside(d, p)) || m.opaque.some((o) => o !== p && isInside(o, p));
  }

  async #upperStat(p: string) {
    return this.fs.stat(this.#upper(p)).catch(() => null);
  }

  async #lowerStat(p: string) {
    return (await this.#hidden(p)) ? null : this.fs.stat(this.#lower(p)).catch(() => null);
  }

  async stat(path: string): Promise<Stat | null> {
    const s = (await this.#upperStat(path)) ?? (await this.#lowerStat(path));
    return s && { ...s, path };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const s = await this.stat(path);
    if (!s) throw new FsError('ENOENT', path);
    if (s.kind === 'dir') throw new FsError('EISDIR', path);
    return (await this.#upperStat(path)) ? this.fs.readFile(this.#upper(path)) : this.fs.readFile(this.#lower(path));
  }

  async readdir(path: string): Promise<Stat[]> {
    const s = await this.stat(path);
    if (!s) throw new FsError('ENOENT', path);
    if (s.kind !== 'dir') throw new FsError('ENOTDIR', path);
    const out = new Map<string, Stat>();
    const up = await this.#upperStat(path);
    if (up?.kind === 'dir') for (const e of await this.fs.readdir(this.#upper(path))) out.set(e.name, { ...e, path: join(path, e.name) });
    const low = await this.#lowerStat(path);
    if (low?.kind === 'dir') {
      for (const e of await this.fs.readdir(this.#lower(path)).catch(() => [])) {
        const p = join(path, e.name);
        if (!out.has(e.name) && !(await this.#hidden(p))) out.set(e.name, { ...e, path: p });
      }
    }
    return [...out.values()];
  }

  /** Makes `p` (a folder) exist in the upper layer, with its parents. */
  async mkdir(path: string): Promise<void> {
    if (path === '/') return this.fs.mkdir(this.#upper('/'));
    const s = await this.stat(path);
    if (s?.kind === 'file') throw new FsError('EEXIST', path);
    if (!s) {
      const m = await this.#load();
      await this.mkdir(dirname(path));
      // Made where something was deleted: the old contents must not show through.
      if (m.deleted.includes(path) || (await this.fs.stat(this.#lower(path)).catch(() => null))) {
        m.deleted = m.deleted.filter((d) => d !== path);
        if (!m.opaque.includes(path)) m.opaque.push(path);
        await this.#save();
      }
    }
    if ((await this.#upperStat(path))?.kind !== 'dir') await this.fs.mkdir(this.#upper(path));
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if ((await this.stat(path))?.kind === 'dir') throw new FsError('EISDIR', path);
    const parent = await this.stat(dirname(path));
    if (!parent) throw new FsError('ENOENT', dirname(path));
    if (parent.kind !== 'dir') throw new FsError('ENOTDIR', dirname(path));
    await this.mkdir(dirname(path));
    const m = await this.#load();
    // A file written over a deleted file replaces it; over a deleted folder, the folder stays deleted.
    if (m.deleted.includes(path) && (await this.fs.stat(this.#lower(path)).catch(() => null))?.kind !== 'dir') {
      m.deleted = m.deleted.filter((d) => d !== path);
      await this.#save();
    }
    await this.fs.writeFile(this.#upper(path), data);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    if (path === '/') throw new FsError('EACCES', path);
    const s = await this.stat(path);
    if (!s) throw new FsError('ENOENT', path);
    if (s.kind === 'dir' && !recursive && (await this.readdir(path)).length) throw new FsError('ENOTEMPTY', path);
    if (await this.#upperStat(path)) await this.fs.rm(this.#upper(path), { recursive: true });
    const m = await this.#load();
    const below = (p: string) => !isInside(path, p);
    m.deleted = m.deleted.filter(below);
    m.opaque = m.opaque.filter(below);
    if (!(await this.#hidden(path)) && (await this.fs.stat(this.#lower(path)).catch(() => null))) m.deleted.push(path);
    await this.#save();
  }

  /** Every file this overlay adds, changes or deletes, compared with the folder below. */
  async changes(): Promise<OverlayChange[]> {
    const out = new Map<string, OverlayChange>();
    const m = await this.#load();
    // Files written here: new, or different from the folder's.
    const walkUpper = async (p: string): Promise<void> => {
      for (const e of await this.fs.readdir(this.#upper(p)).catch(() => [])) {
        const rel = join(p, e.name);
        if (e.kind === 'dir') {
          await walkUpper(rel);
          continue;
        }
        const low = await this.#lowerStat(rel);
        if (low?.kind === 'file') {
          const [a, b] = await Promise.all([this.fs.readFile(this.#upper(rel)), this.fs.readFile(this.#lower(rel))]);
          if (!same(a, b)) out.set(rel, { path: rel, kind: 'modified' });
        } else out.set(rel, { path: rel, kind: 'added' });
      }
    };
    await walkUpper('/');
    // Files of the folder hidden by a deletion, and not written again.
    const walkLower = async (p: string): Promise<void> => {
      const s = await this.fs.stat(this.#lower(p)).catch(() => null);
      if (!s) return;
      if (s.kind === 'dir') {
        for (const e of await this.fs.readdir(this.#lower(p)).catch(() => [])) await walkLower(join(p, e.name));
      } else if (!out.has(p) && (await this.#upperStat(p))?.kind !== 'file') out.set(p, { path: p, kind: 'deleted' });
    };
    for (const d of [...m.deleted, ...m.opaque]) await walkLower(d);
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Copies changes into the folder below and forgets them here. All of them,
   * or only `paths` (files, or folders: everything in them). Returns the paths applied.
   */
  async apply(paths?: string[]): Promise<string[]> {
    const picked = (await this.changes()).filter((c) => !paths || paths.some((p) => isInside(p, c.path)));
    // Deletions first: a file may take the place of a deleted folder.
    for (const c of picked) if (c.kind === 'deleted') await this.fs.rm(this.#lower(c.path), { recursive: true }).catch(() => undefined);
    // Folders deleted here go too (empty ones included).
    const m = await this.#load();
    for (const d of m.deleted) {
      if (paths && !paths.some((p) => isInside(p, d))) continue;
      if ((await this.fs.stat(this.#lower(d)).catch(() => null))?.kind === 'dir') await this.fs.rm(this.#lower(d), { recursive: true }).catch(() => undefined);
    }
    for (const c of picked) if (c.kind !== 'deleted') await this.fs.writeFile(this.#lower(c.path), await this.fs.readFile(this.#upper(c.path)));
    await this.discard(paths);
    return picked.map((c) => c.path);
  }

  /** Throws changes away (all of them, or only `paths`): the overlay shows the folder below again. */
  async discard(paths?: string[]): Promise<void> {
    const m = await this.#load();
    if (!paths) {
      await this.fs.rm(`${this.store}/tree`, { recursive: true }).catch(() => undefined);
      this.#meta = { deleted: [], opaque: [] };
      await this.fs.mkdir(`${this.store}/tree`);
      return this.#save();
    }
    for (const p of paths) {
      await this.fs.rm(this.#upper(p), { recursive: true }).catch(() => undefined);
      // Inside a deleted folder: the folder stays deleted except for the way to `p`.
      for (const d of m.deleted.filter((d) => d !== p && isInside(d, p))) {
        m.deleted = m.deleted.filter((x) => x !== d);
        for (let dir = d; dir !== p; ) {
          const slash = p.indexOf('/', dir.length + 1);
          const next = slash < 0 ? p : p.slice(0, slash);
          for (const e of await this.fs.readdir(this.#lower(dir)).catch(() => [])) if (join(dir, e.name) !== next) m.deleted.push(join(dir, e.name));
          dir = next;
        }
      }
      const keep = (q: string) => !isInside(p, q);
      m.deleted = m.deleted.filter(keep);
      m.opaque = m.opaque.filter(keep);
    }
    await this.#save();
  }
}
