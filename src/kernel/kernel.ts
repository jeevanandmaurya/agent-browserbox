import { Bus } from './bus';
import { detectCaps, type PlatformCap } from './caps';
import { KCore } from './kcore';
import { Permissions } from './perms';
import { ProcTable } from './proc';
import { ProcFs } from './procfs';
import { Secrets } from './secrets';
import { Settings } from './settings';
import type { KernelEvents, Notice } from './types';
import { HandleFs } from './vfs/handlefs';
import { MemFs } from './vfs/memfs';
import { Vfs } from './vfs/vfs';

export const HOME = '/home/user';
export const AGENT_HOME = '/home/agent';

const WELCOME = `# Welcome to BrowserBox

BrowserBox is an operating system for AI agents that runs entirely in this
browser tab. Nothing leaves your machine except the model requests you configure.

- **Agent** — chat with an agent that can use every tool in the OS.
- **Terminal** — a shell. Try \`help\`, \`ls /proc\`, \`agent "summarise this folder"\`.
- **Files / Editor** — browse and edit the persistent filesystem (OPFS).
- **Task Manager** — watch and kill processes, including running agents.
- **Settings** — pick a model: Claude, a local server (Ollama, LM Studio,
  llama.cpp) or a model running in this tab on WebGPU.

The agent works in \`/home/agent\`. Files there survive reloads.
`;

/**
 * The kernel: owns every shared service. Constructing it is synchronous and
 * cheap so the desktop can paint immediately; storage comes up in the
 * background and filesystem calls simply await `fs.ready`.
 */
export class Kernel {
  readonly version = '0.1.0';
  readonly bootStart = 0;
  readonly bus = new Bus<KernelEvents>();
  readonly settings = new Settings(this.bus);
  readonly secrets = new Secrets();
  readonly perms = new Permissions(this.settings);
  readonly procs = new ProcTable(this.bus);
  readonly fs = new Vfs(this.bus);
  readonly kcore = new KCore();
  readonly caps: PlatformCap[] = detectCaps();
  /** 'opfs' when the root is persistent, 'memory' when it is not. */
  rootKind: 'opfs' | 'memory' = 'memory';
  /** Milestones recorded during boot, in ms since navigation start. */
  readonly bootMarks: Array<{ name: string; at: number }> = [];

  mark(name: string): void {
    this.bootMarks.push({ name, at: Math.round(performance.now() * 10) / 10 });
  }

  hasCap(id: string): boolean {
    return this.caps.find((c) => c.id === id)?.ok ?? false;
  }

  notify(notice: Notice | string): void {
    this.bus.emit('notify', typeof notice === 'string' ? { title: notice } : notice);
  }

  openApp(id: string, args?: Record<string, unknown>): void {
    this.bus.emit('app:open', { id, args });
  }

  /** Brings up storage and background services. Never rejects. */
  async start(): Promise<void> {
    const init = this.procs.spawn({ name: 'kernel', kind: 'service', detail: 'event bus, vfs, process table' });
    this.procs.update(init.pid, { state: 'idle' });
    void this.kcore.load().then(() => this.mark('kcore.wasm'));

    try {
      const root = await navigator.storage.getDirectory();
      this.fs.mount('/', new HandleFs(root, 'opfs'));
      this.rootKind = 'opfs';
    } catch {
      this.fs.mount('/', new MemFs());
    }
    this.fs.mount('/tmp', new MemFs());
    this.fs.mount('/proc', new ProcFs(this));
    this.fs.markReady();
    this.mark('filesystem');

    try {
      await this.#seed();
    } catch (err) {
      console.error('[kernel] seeding the filesystem failed', err);
    }
    // Ask the browser not to evict our data; harmless if refused.
    void navigator.storage?.persist?.().catch(() => false);
  }

  async #seed(): Promise<void> {
    if (await this.fs.exists(`${HOME}/Welcome.md`)) return;
    await Promise.all([this.fs.mkdir(`${HOME}/Documents`), this.fs.mkdir(AGENT_HOME), this.fs.mkdir('/mnt')]);
    await this.fs.writeFile(`${HOME}/Welcome.md`, WELCOME);
    await this.fs.writeFile(
      `${AGENT_HOME}/MEMORY.md`,
      '# Agent memory\n\nDurable notes the agent keeps across sessions. Edit freely.\n',
    );
  }

  /** Mounts a real folder chosen by the user under /mnt (File System Access API). */
  async mountNativeFolder(): Promise<string> {
    const picker = (globalThis as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) throw new Error('This browser does not support mounting local folders (File System Access API).');
    const handle = await picker({ mode: 'readwrite' });
    const point = `/mnt/${handle.name.replace(/[^\w.-]+/g, '_') || 'folder'}`;
    this.fs.mount(point, new HandleFs(handle, `native:${handle.name}`));
    return point;
  }
}

export type { Notice };
