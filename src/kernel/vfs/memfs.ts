import { basename, dirname } from './path';
import { FsError, type FsBackend, type Stat } from './types';

interface Node {
  kind: 'file' | 'dir';
  data?: Uint8Array;
  mtime: number;
}

/** In-memory filesystem: backs /tmp and is the fallback when OPFS is unavailable. */
export class MemFs implements FsBackend {
  readonly label = 'memfs';
  #nodes = new Map<string, Node>([['/', { kind: 'dir', mtime: Date.now() }]]);

  async readFile(path: string): Promise<Uint8Array> {
    const n = this.#nodes.get(path);
    if (!n) throw new FsError('ENOENT', path);
    if (n.kind === 'dir') throw new FsError('EISDIR', path);
    return n.data!.slice();
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const parent = this.#nodes.get(dirname(path));
    if (!parent) throw new FsError('ENOENT', dirname(path));
    if (parent.kind !== 'dir') throw new FsError('ENOTDIR', dirname(path));
    if (this.#nodes.get(path)?.kind === 'dir') throw new FsError('EISDIR', path);
    this.#nodes.set(path, { kind: 'file', data: data.slice(), mtime: Date.now() });
  }

  async readdir(path: string): Promise<Stat[]> {
    const n = this.#nodes.get(path);
    if (!n) throw new FsError('ENOENT', path);
    if (n.kind !== 'dir') throw new FsError('ENOTDIR', path);
    const prefix = path === '/' ? '/' : path + '/';
    const out: Stat[] = [];
    for (const [p, node] of this.#nodes) {
      if (p !== '/' && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push(this.#stat(p, node));
    }
    return out;
  }

  async stat(path: string): Promise<Stat | null> {
    const n = this.#nodes.get(path);
    return n ? this.#stat(path, n) : null;
  }

  async mkdir(path: string): Promise<void> {
    if (path === '/') return;
    const existing = this.#nodes.get(path);
    if (existing) {
      if (existing.kind === 'dir') return;
      throw new FsError('EEXIST', path);
    }
    await this.mkdir(dirname(path));
    this.#nodes.set(path, { kind: 'dir', mtime: Date.now() });
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const n = this.#nodes.get(path);
    if (!n) throw new FsError('ENOENT', path);
    if (path === '/') throw new FsError('EACCES', path);
    const prefix = path + '/';
    const children = [...this.#nodes.keys()].filter((p) => p.startsWith(prefix));
    if (children.length && !recursive) throw new FsError('ENOTEMPTY', path);
    for (const p of children) this.#nodes.delete(p);
    this.#nodes.delete(path);
  }

  #stat(path: string, n: Node): Stat {
    return { path, name: basename(path), kind: n.kind, size: n.data?.byteLength ?? 0, mtime: n.mtime };
  }
}
