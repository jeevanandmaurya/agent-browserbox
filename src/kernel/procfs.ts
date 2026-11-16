import type { Kernel } from './kernel';
import { FsError, type FsBackend, type Stat } from './vfs/types';

const enc = new TextEncoder();

/** Read-only synthetic filesystem at /proc exposing live kernel state as text. */
export class ProcFs implements FsBackend {
  readonly label = 'procfs';
  readonly readonly = true;
  #files: Record<string, () => string | Promise<string>>;

  constructor(os: Kernel) {
    this.#files = {
      ps: () => os.procs.list().map((p) => `${p.pid}\t${p.ppid}\t${p.kind}\t${p.state}\t${Math.round(p.cpuMs)}ms\t${p.name}\t${p.detail}`).join('\n') + '\n',
      mounts: () => os.fs.mounts().map((m) => `${m.fs.label}\t${m.point}\t${m.fs.readonly ? 'ro' : 'rw'}`).join('\n') + '\n',
      caps: () => os.caps.map((c) => `${c.ok ? 'yes' : 'no '}\t${c.id}\t${c.label}`).join('\n') + '\n',
      uptime: () => `${((performance.now() - os.bootStart) / 1000).toFixed(1)}\n`,
      version: () => `BrowserBox ${os.version} (${navigator.userAgent})\n`,
      meminfo: async () => {
        const est = await navigator.storage?.estimate?.().catch(() => undefined);
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        return [
          `DeviceMemoryGB:\t${(navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 'unknown'}`,
          `JsHeapUsed:\t${heap?.usedJSHeapSize ?? 'unknown'}`,
          `JsHeapLimit:\t${heap?.jsHeapSizeLimit ?? 'unknown'}`,
          `StorageUsed:\t${est?.usage ?? 'unknown'}`,
          `StorageQuota:\t${est?.quota ?? 'unknown'}`,
          `Cores:\t${navigator.hardwareConcurrency ?? 'unknown'}`,
        ].join('\n') + '\n';
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const f = this.#files[path.slice(1)];
    if (!f) throw new FsError(path === '/' ? 'EISDIR' : 'ENOENT', path);
    return enc.encode(await f());
  }
  async writeFile(path: string): Promise<void> {
    throw new FsError('EACCES', path);
  }
  async readdir(path: string): Promise<Stat[]> {
    if (path !== '/') throw new FsError('ENOTDIR', path);
    return Object.keys(this.#files).map((name) => ({ path: '/' + name, name, kind: 'file', size: 0, mtime: Date.now() }));
  }
  async stat(path: string): Promise<Stat | null> {
    if (path === '/') return { path, name: '', kind: 'dir', size: 0, mtime: 0 };
    const name = path.slice(1);
    return name in this.#files ? { path, name, kind: 'file', size: 0, mtime: Date.now() } : null;
  }
  async mkdir(path: string): Promise<void> {
    throw new FsError('EACCES', path);
  }
  async remove(path: string): Promise<void> {
    throw new FsError('EACCES', path);
  }
}
