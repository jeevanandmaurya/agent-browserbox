import { McpHub } from '@/agent/ext/mcp';
import { Bus } from './bus';
import { detectCaps, type PlatformCap } from './caps';
import { KCore } from './kcore';
import { PackManager } from './packs';
import { Permissions } from './perms';
import { ProcTable } from './proc';
import { ProcFs } from './procfs';
import { Secrets } from './secrets';
import { loadSettings, persistSetting, Settings } from './settings';
import type { KernelEvents, Notice } from './types';
import { HandleFs } from './vfs/handlefs';
import { MemFs } from './vfs/memfs';
import { Vfs } from './vfs/vfs';
import type { AgentsApi, Kernel, ShellsApi } from './api';

import { AGENT_HOME, HOME } from './paths';

export { AGENT_HOME, HOME };

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

/** Things only a window can do; the kernel borrows one when a tool needs them. */
export interface UiBridge {
  call<T>(method: 'clipboard.read' | 'clipboard.write' | 'speak', ...args: unknown[]): Promise<T>;
}

/**
 * The kernel proper. It has no UI and no DOM dependencies, so it runs
 * headless in a worker; windows talk to it through `RemoteKernel`.
 */
export class KernelCore implements Kernel {
  readonly version = '0.1.0';
  readonly bootStart = 0;
  readonly bus = new Bus<KernelEvents>();
  readonly settings = new Settings(this.bus, (key, value) => {
    void persistSetting(key, value);
    this.onSettingWritten?.(key, value);
  });
  /** Hook for cross-kernel sync when several kernels share storage (no SharedWorker). */
  onSettingWritten?: (key: string, value: unknown) => void;
  readonly secrets = new Secrets();
  readonly perms = new Permissions(this.settings);
  readonly procs = new ProcTable(this.bus);
  readonly fs = new Vfs(this.bus);
  readonly kcore = new KCore();
  readonly caps: PlatformCap[] = detectCaps();
  /** Installed by the worker entry point once the managers exist. */
  agents!: AgentsApi;
  shells!: ShellsApi;
  ui: UiBridge | null = null;
  /** Connections to remote MCP servers (connectors). */
  readonly mcp = new McpHub(this);
  readonly packs = new PackManager(this);
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
    this.settings.hydrate(await loadSettings());

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
    // Example skills, agents and commands; only when the folder has never existed.
    if (!(await this.fs.exists(`${AGENT_HOME}/skills`))) {
      const { SEED } = await import('@/agent/ext/library');
      for (const [path, text] of SEED) await this.fs.writeFile(path, text);
    }
    if (await this.fs.exists(`${HOME}/Welcome.md`)) return;
    await Promise.all([this.fs.mkdir(`${HOME}/Documents`), this.fs.mkdir(AGENT_HOME), this.fs.mkdir('/mnt')]);
    await this.fs.writeFile(`${HOME}/Welcome.md`, WELCOME);
    await this.fs.writeFile(
      `${AGENT_HOME}/MEMORY.md`,
      '# Agent memory\n\nDurable notes the agent keeps across sessions. Edit freely.\n',
    );
  }

  /** Folder pickers need a window; `RemoteKernel` shows the picker and calls `mountHandle`. */
  async mountNativeFolder(): Promise<string> {
    throw new Error("Mounting a folder needs a window: use Files → Mount.");
  }

  mountHandle(handle: FileSystemDirectoryHandle): string {
    const point = `/mnt/${handle.name.replace(/[^\w.-]+/g, '_') || 'folder'}`;
    this.fs.mount(point, new HandleFs(handle, `native:${handle.name}`));
    return point;
  }
}

export type { Kernel } from './api';
export type { Notice };
