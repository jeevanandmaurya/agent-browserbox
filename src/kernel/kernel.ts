import { McpHub } from '@/agent/ext/mcp';
import { Bus } from './bus';
import { detectCaps, type PlatformCap } from './caps';
import { KCore } from './kcore';
import { setEsbuildLoader } from './dev/bundle';
import { loadEsbuild } from './dev/esbuild-loader';
import { DevServers } from './dev/server';
import { PackageManager } from './packages';
import { Permissions } from './perms';
import { ProcTable } from './proc';
import { ProcFs } from './procfs';
import { Secrets } from './secrets';
import { loadSettings, persistSetting, Settings } from './settings';
import type { KernelEvents, KernelLogLine, Notice } from './types';
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
  readonly packages = new PackageManager(this);
  readonly dev = new DevServers(this);

  constructor() {
    setEsbuildLoader(() => loadEsbuild(this.packages, (msg) => this.log('dev', msg)));
  }
  /** The kernel log (`dmesg`): what the kernel did, with times since it started. */
  readonly kernelLog: KernelLogLine[] = [];
  /** 'opfs' when the root is persistent, 'memory' when it is not. */
  rootKind: 'opfs' | 'memory' = 'memory';
  /** Milestones recorded during boot, in ms since navigation start. */
  readonly bootMarks: Array<{ name: string; at: number }> = [];

  mark(name: string): void {
    this.bootMarks.push({ name, at: Math.round(performance.now() * 10) / 10 });
  }

  log(src: string, msg: string): void {
    const line = { t: Math.round(performance.now()), src, msg };
    this.kernelLog.push(line);
    if (this.kernelLog.length > 500) this.kernelLog.shift();
    this.bus.emit('kmsg', line);
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
    this.log('kernel', `BrowserBox ${this.version}`);
    const init = this.procs.spawn({ name: 'kernel', kind: 'service', detail: 'event bus, vfs, process table' });
    this.procs.update(init.pid, { state: 'idle' });
    // Loads in parallel with storage; awaited before "ready" so the log reads in order.
    const kcore = this.kcore.load().then(() => this.log('kcore', this.kcore.loaded ? 'WebAssembly core loaded' : 'WebAssembly unavailable, using JavaScript fallbacks'));
    this.settings.hydrate(await loadSettings());
    this.log('settings', `${this.settings.keys().length} keys loaded`);

    try {
      const root = await navigator.storage.getDirectory();
      this.fs.mount('/', new HandleFs(root, 'opfs'));
      this.rootKind = 'opfs';
      this.log('vfs', 'mounted opfs on / (persistent)');
    } catch {
      this.fs.mount('/', new MemFs());
      this.log('vfs', 'OPFS unavailable: mounted memfs on / (not persistent)');
    }
    this.fs.mount('/tmp', new MemFs());
    this.fs.mount('/proc', new ProcFs(this));
    this.fs.markReady();
    this.log('vfs', 'mounted memfs on /tmp, procfs on /proc');

    try {
      await this.#seed();
    } catch (err) {
      this.log('init', `seeding the filesystem failed: ${(err as Error).message}`);
    }
    const pkgs = this.packages.installed();
    this.log('pkg', pkgs.length ? `installed: ${pkgs.join(', ')}` : 'no packages installed');
    const gpu = this.hasCap('webgpu') ? 'WebGPU available' : 'no WebGPU';
    this.log('caps', `${this.caps.filter((c) => c.ok).length}/${this.caps.length} platform features · ${gpu} · ${navigator.hardwareConcurrency ?? '?'} cores`);
    // Ask the browser not to evict our data; harmless if refused.
    void navigator.storage
      ?.persist?.()
      .then((ok) => this.log('vfs', ok ? 'storage marked persistent' : 'storage may be evicted under pressure'))
      .catch(() => false);
    await kcore;
    this.log('kernel', 'ready');
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
