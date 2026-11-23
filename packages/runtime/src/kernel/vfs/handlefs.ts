import { basename, dirname } from './path';
import { FsError, type FsBackend, type Stat } from './types';

/**
 * Filesystem over a FileSystemDirectoryHandle. Used for both the Origin
 * Private File System (persistent root) and user-granted native folders
 * mounted through the File System Access API.
 */
export class HandleFs implements FsBackend {
  #dirs = new Map<string, FileSystemDirectoryHandle>();

  #hidden: Set<string>;

  /** `hidden`: top-level folders this filesystem does not show or let anyone reach. */
  constructor(
    root: FileSystemDirectoryHandle,
    readonly label: string,
    hidden: string[] = [],
  ) {
    this.#dirs.set('/', root);
    this.#hidden = new Set(hidden);
  }

  #isHidden(path: string): boolean {
    return this.#hidden.size > 0 && this.#hidden.has(path.split('/')[1] ?? '');
  }

  #guard(path: string): void {
    if (this.#isHidden(path)) throw new FsError('ENOENT', path);
  }

  async #dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const cached = this.#dirs.get(path);
    if (cached) return cached;
    const parent = await this.#dir(dirname(path), create);
    try {
      const h = await parent.getDirectoryHandle(basename(path), { create });
      this.#dirs.set(path, h);
      return h;
    } catch (err) {
      throw this.#wrap(err, path);
    }
  }

  #wrap(err: unknown, path: string): FsError {
    const name = (err as DOMException)?.name;
    if (name === 'NotFoundError') return new FsError('ENOENT', path);
    if (name === 'TypeMismatchError') return new FsError('ENOTDIR', path);
    if (name === 'NotAllowedError' || name === 'SecurityError') return new FsError('EACCES', path);
    if (name === 'InvalidModificationError') return new FsError('ENOTEMPTY', path);
    return new FsError('EIO', path, (err as Error)?.message);
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.#guard(path);
    try {
      const dir = await this.#dir(dirname(path));
      const fh = await dir.getFileHandle(basename(path));
      // A file being written at this moment can fail to read (NotReadableError); it is readable a moment later.
      for (let attempt = 0; ; attempt++) {
        try {
          return new Uint8Array(await (await fh.getFile()).arrayBuffer());
        } catch (err) {
          if (attempt >= 4 || (err as DOMException)?.name !== 'NotReadableError') throw err;
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        }
      }
    } catch (err) {
      if (err instanceof FsError) throw err;
      const e = this.#wrap(err, path);
      throw e.code === 'ENOTDIR' ? new FsError('EISDIR', path) : e;
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (this.#isHidden(path)) throw new FsError('EACCES', path);
    try {
      const dir = await this.#dir(dirname(path));
      const fh = await dir.getFileHandle(basename(path), { create: true });
      const w = await fh.createWritable();
      await w.write(data as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (err) {
      throw err instanceof FsError ? err : this.#wrap(err, path);
    }
  }

  async readdir(path: string): Promise<Stat[]> {
    this.#guard(path);
    const dir = await this.#dir(path);
    const prefix = path === '/' ? '/' : path + '/';
    const jobs: Promise<Stat>[] = [];
    for await (const [name, handle] of dir.entries()) {
      const p = prefix + name;
      if (path === '/' && this.#hidden.has(name)) continue;
      if (handle.kind === 'directory') jobs.push(Promise.resolve({ path: p, name, kind: 'dir', size: 0, mtime: 0 }));
      else
        jobs.push(
          (handle as FileSystemFileHandle)
            .getFile()
            .then((f): Stat => ({ path: p, name, kind: 'file', size: f.size, mtime: f.lastModified }))
            .catch((): Stat => ({ path: p, name, kind: 'file', size: 0, mtime: 0 })),
        );
    }
    return Promise.all(jobs);
  }

  async stat(path: string): Promise<Stat | null> {
    if (path === '/') return { path, name: '', kind: 'dir', size: 0, mtime: 0 };
    if (this.#isHidden(path)) return null;
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.#dir(dirname(path));
    } catch {
      return null;
    }
    const name = basename(path);
    try {
      const f = await (await dir.getFileHandle(name)).getFile();
      return { path, name, kind: 'file', size: f.size, mtime: f.lastModified };
    } catch {
      try {
        await dir.getDirectoryHandle(name);
        return { path, name, kind: 'dir', size: 0, mtime: 0 };
      } catch {
        return null;
      }
    }
  }

  async mkdir(path: string): Promise<void> {
    if (this.#isHidden(path)) throw new FsError('EACCES', path);
    await this.#dir(path, true);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    if (path === '/' || this.#isHidden(path)) throw new FsError('EACCES', path);
    try {
      const dir = await this.#dir(dirname(path));
      await dir.removeEntry(basename(path), { recursive });
    } catch (err) {
      throw err instanceof FsError ? err : this.#wrap(err, path);
    }
    for (const key of [...this.#dirs.keys()]) if (key === path || key.startsWith(path + '/')) this.#dirs.delete(key);
  }
}
