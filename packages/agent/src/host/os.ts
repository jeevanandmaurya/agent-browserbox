import type { BuiltinPromptInput } from '../providers/builtin-run.js';
import type { BoxShell, BrowserBox, DevLogEntry, DevServer, FileStat } from '@jeevanand/agent-browserbox-sdk';
import { McpHub } from '../ext/mcp.js';
import type { Provider } from '../types.js';
import { basename, join } from './path.js';
import { AGENT_HOME, HOME } from './paths.js';
import { Permissions, type Capability, type PermDecision, type PermRequest, type Prompter } from './perms.js';

/**
 * The agent's view of the world it works in. The agent's code was written
 * against BrowserBox's kernel; this gives it the same surface (`os.fs`,
 * `os.settings`, `os.packages`, …) backed by a BrowserBox reached through the
 * SDK, plus what only the app can provide (keys, clipboard, opening apps).
 */

// ---- types the agent's code uses ------------------------------------------------

export type { Capability, PermDecision, PermRequest, Prompter };
export type Stat = FileStat;
export type DevLog = DevLogEntry;
export type DevInfo = DevServer;

export interface Notice {
  title: string;
  body?: string;
  level?: 'info' | 'ok' | 'warn' | 'error';
}

export interface SettingsApi {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

export interface SecretsApi {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
}

export interface PackageManifest {
  id: string;
  version: string;
  summary: string;
  commands: string[];
  tools: string[];
  default: boolean;
}

/** Apps the host can open (open_app): ids and names. Empty when there are none. */
export interface AppInfo {
  id: string;
  name: string;
  hidden?: boolean;
}

export interface PlatformCap {
  id: string;
  label: string;
  ok: boolean;
}

/** A process the agent itself runs (the agent, a model download, …), for its own bookkeeping. */
export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly kind: string;
  readonly started: number;
  state: 'running' | 'idle' | 'blocked';
  detail: string;
  cpuMs: number;
  memBytes: number;
  readonly signal: AbortSignal;
}

/** Things only the app embedding the agent can do. Every one is optional. */
export interface AgentUi {
  notify?(notice: Notice): void;
  /** Opens one of `apps` (or 'preview' with { html | path | dev }). */
  openApp?(id: string, args?: Record<string, unknown>): void;
  apps?: AppInfo[];
  clipboardRead?(): Promise<string>;
  clipboardWrite?(text: string): Promise<void>;
  speak?(text: string): void;
  /**
   * Runs a prompt on the browser's built-in model in a page, for an agent in a
   * worker (where the Prompt API may be missing). Without it, the agent uses
   * `LanguageModel` in its own scope when there is one.
   */
  builtinPrompt?(input: BuiltinPromptInput, signal: AbortSignal, onChunk?: (text: string) => void): Promise<{ text: string; window?: number; tooLarge?: boolean }>;
  /**
   * Drives a page for the `preview` tool (a page in a window: open, read, click,
   * type, screenshot…). `sid` is the chat, which has its own page. Without it,
   * the agent has no preview tool.
   */
  preview?(sid: string, action: string, args: Record<string, unknown>): Promise<{ text: string; image?: string }>;
  /** The chat window renders ```ui blocks (see ui-spec.ts): the agent is told it can use them. */
  blocks?: boolean;
}

export interface AgentOsOptions {
  /**
   * The agent's settings: model and provider config ('agent.config'),
   * permission mode and grants ('perms.*'), MCP connectors, … Pass your stored
   * values; `onSettingsChange` receives every write so you can store them.
   */
  settings?: Record<string, unknown> | SettingsApi;
  onSettingsChange?(key: string, value: unknown): void;
  /** API keys and tokens by name (see SECRET in config): a map, or your own store. */
  secrets?: Record<string, string> | SecretsApi;
  /**
   * Asked before gated actions (writing outside the workspace, running code,
   * network, …) unless already granted. Without one, the permission mode
   * defaults to 'auto': the box is the sandbox.
   */
  prompter?: Prompter;
  ui?: AgentUi;
  /**
   * A model of your own, used instead of the configured provider ('agent.config'):
   * anything implementing Provider (one turn of the conversation per call).
   */
  provider?: Provider | (() => Provider | Promise<Provider>);
  /**
   * Where the agent's own processes (the agent, a model download) are listed,
   * e.g. a kernel client's process table so they show in a task manager.
   * Default: kept in the agent.
   */
  procs?: ProcTable;
  /** Write the example skills, agents and commands to the agent's home if it has none. Default: true. */
  seed?: boolean;
}

// ---- implementations --------------------------------------------------------------

/** Settings kept in memory; every write is reported to `onChange`. */
export class Settings implements SettingsApi {
  #values: Map<string, unknown>;
  constructor(
    initial: Record<string, unknown> = {},
    private onChange?: (key: string, value: unknown) => void,
  ) {
    this.#values = new Map(Object.entries(initial));
  }
  get<T>(key: string, fallback: T): T {
    return this.#values.has(key) ? (structuredClone(this.#values.get(key)) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.#values.set(key, structuredClone(value));
    this.onChange?.(key, value);
  }
  delete(key: string): void {
    this.#values.delete(key);
    this.onChange?.(key, undefined);
  }
  keys(): string[] {
    return [...this.#values.keys()];
  }
  entries(): Record<string, unknown> {
    return Object.fromEntries(this.#values);
  }
}

class MapSecrets implements SecretsApi {
  #m: Map<string, string>;
  constructor(initial: Record<string, string>) {
    this.#m = new Map(Object.entries(initial));
  }
  async get(name: string) {
    return this.#m.get(name) ?? null;
  }
  async set(name: string, value: string) {
    if (value) this.#m.set(name, value);
    else this.#m.delete(name);
  }
  async delete(name: string) {
    this.#m.delete(name);
  }
  async has(name: string) {
    return this.#m.has(name);
  }
}

/** The box's filesystem, with the kernel's method names (and a few it builds from others). */
class BoxFs {
  readonly ready = Promise.resolve();
  constructor(private at: () => BrowserBox) {}
  private get box(): BrowserBox {
    return this.at();
  }
  readFile = (p: string) => this.box.fs.readFile(p);
  readText = (p: string) => this.box.fs.readTextFile(p);
  writeFile = (p: string, d: string | Uint8Array) => this.box.fs.writeFile(p, d);
  appendFile = (p: string, d: string | Uint8Array) => this.box.fs.appendFile(p, d);
  readdir = (p: string) => this.box.fs.readdir(p);
  stat = (p: string) => this.box.fs.stat(p);
  exists = (p: string) => this.box.fs.exists(p);
  mkdir = (p: string) => this.box.fs.mkdir(p);
  rm = (p: string, o?: { recursive?: boolean }) => this.box.fs.rm(p, o);
  cp = (a: string, b: string) => this.box.fs.cp(a, b);
  mv = (a: string, b: string) => this.box.fs.rename(a, b);
  glob = (pattern: string, cwd = HOME, limit?: number) => this.box.fs.glob(pattern, { cwd, limit });
  overlay = (point: string, lower: string, store: string) => this.box.fs.overlay(point, lower, store);
  overlayChanges = (point: string) => this.box.fs.overlayChanges(point);
  overlayApply = (point: string, paths?: string[]) => this.box.fs.overlayApply(point, paths);
  overlayDiscard = (point: string, paths?: string[]) => this.box.fs.overlayDiscard(point, paths);
  /** Every entry under `root`, depth first. */
  async *walk(root: string, opts: { maxDepth?: number; signal?: AbortSignal } = {}): AsyncGenerator<Stat> {
    const visit = async function* (fs: BoxFs, dir: string, depth: number): AsyncGenerator<Stat> {
      if (opts.signal?.aborted) return;
      for (const s of await fs.readdir(dir).catch(() => [] as Stat[])) {
        yield s;
        if (s.kind === 'dir' && depth < (opts.maxDepth ?? 64)) yield* visit(fs, s.path, depth + 1);
      }
    };
    yield* visit(this, root, 0);
  }
  mounts(): Array<{ point: string; fs: { label: string } }> {
    return [{ point: '/', fs: { label: this.box.storage === 'opfs' ? 'opfs' : 'memory' } }];
  }
}

/**
 * Packages are installed in the box with its `pkg` command. The list is read
 * once (refresh()) and kept, so `isInstalled` can stay synchronous as the
 * agent's code expects.
 */
class BoxPackages {
  #list: Array<PackageManifest & { installed: boolean }> = [];
  constructor(private at: () => BrowserBox) {}
  private get box(): BrowserBox {
    return this.at();
  }

  async refresh(): Promise<void> {
    const r = await this.box.exec('pkg list');
    if (r.exitCode !== 0) return;
    const list: Array<PackageManifest & { installed: boolean }> = [];
    for (const line of r.stdout.split('\n')) {
      // A package line (not the legend under the list: "i = installed · …").
      const m = /^(i| ) ([a-z0-9][a-z0-9._-]*)\s+(?:~?\S+ \S+)?\s+(.*)$/.exec(line);
      if (!m) continue;
      const info = await this.box.exec(`pkg info ${m[2]}`);
      const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(info.stdout)?.[1]?.trim() ?? '';
      const names = (k: string) => field(k).split(',').map((s) => s.trim()).filter((s) => s && s !== '—');
      list.push({ id: m[2]!, version: info.stdout.split('\n')[0]?.split(' ')[1] ?? '', summary: m[3]!.trim(), commands: names('commands'), tools: names('tools'), default: false, installed: m[1] === 'i' });
    }
    this.#list = list;
  }
  manifests(): PackageManifest[] {
    return this.#list;
  }
  isInstalled(id: string): boolean {
    return this.#list.some((p) => p.id === id && p.installed);
  }
  async install(id: string): Promise<void> {
    const r = await this.box.exec(`pkg install ${id}`, { timeoutMs: 600_000 });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `pkg install ${id} failed`);
    await this.refresh();
  }
}

/** What the agent needs from a process table for its own processes. */
export interface ProcTable {
  spawn(o: { name: string; kind: string; ppid?: number; detail?: string; onKill?: () => void }): Proc;
  update(pid: number, patch: Partial<Pick<Proc, 'state' | 'detail' | 'memBytes'>>): void;
  account(pid: number, ms: number): void;
  exit(pid: number): void;
  kill(pid: number): boolean;
  list(): Proc[];
}

/** The agent's own processes, kept in the agent. The box's process table is `box.processes()`. */
class LocalProcs implements ProcTable {
  #next = 1;
  #onExit = new Set<(pid: number) => void>();
  /** Called with each process that exits (or is killed). */
  onExit(fn: (pid: number) => void): () => void {
    this.#onExit.add(fn);
    return () => this.#onExit.delete(fn);
  }
  #procs = new Map<number, Proc & { ctl: AbortController; onKill?: () => void }>();
  spawn(o: { name: string; kind: string; ppid?: number; detail?: string; onKill?: () => void }): Proc {
    const ctl = new AbortController();
    const p = { pid: this.#next++, ppid: o.ppid ?? 0, name: o.name, kind: o.kind, started: Date.now(), state: 'running' as const, detail: o.detail ?? '', cpuMs: 0, memBytes: 0, signal: ctl.signal, ctl, onKill: o.onKill };
    this.#procs.set(p.pid, p);
    return p;
  }
  update(pid: number, patch: Partial<Pick<Proc, 'state' | 'detail' | 'memBytes'>>): void {
    const p = this.#procs.get(pid);
    if (p) Object.assign(p, patch);
  }
  account(pid: number, ms: number): void {
    const p = this.#procs.get(pid);
    if (p) p.cpuMs += ms;
  }
  exit(pid: number): void {
    const p = this.#procs.get(pid);
    if (!p) return;
    p.ctl.abort();
    this.#procs.delete(pid);
    for (const fn of this.#onExit) fn(pid);
  }
  kill(pid: number): boolean {
    const p = this.#procs.get(pid);
    if (!p) return false;
    p.onKill?.();
    this.exit(pid);
    return true;
  }
  list(): Proc[] {
    return [...this.#procs.values()];
  }
}

/** Adds exit notifications to a process table (the session manager forgets sessions whose agent exited). */
function withExitEvents(t: ProcTable): ProcTable & { onExit(fn: (pid: number) => void): () => void } {
  if (t instanceof LocalProcs) return t;
  const listeners = new Set<(pid: number) => void>();
  const fire = (pid: number) => listeners.forEach((fn) => fn(pid));
  return {
    spawn: (o) => t.spawn(o),
    update: (pid, patch) => t.update(pid, patch),
    account: (pid, ms) => t.account(pid, ms),
    exit: (pid) => (t.exit(pid), fire(pid)),
    kill: (pid) => {
      const ok = t.kill(pid);
      if (ok) fire(pid);
      return ok;
    },
    list: () => t.list(),
    onExit: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
}

/** Token estimates and line search (the kernel's WebAssembly core has the same in JS). */
const enc = new TextEncoder();
const kcore = {
  estimateTokens: (text: string) => Math.ceil(text.length / 3.6),
  searchLines(hay: Uint8Array, needle: string, ignoreCase = false, cap = 1000): { total: number; matches: Array<{ line: number; offset: number }> } {
    const text = new TextDecoder().decode(hay);
    const q = ignoreCase ? needle.toLowerCase() : needle;
    const matches: Array<{ line: number; offset: number }> = [];
    let total = 0;
    let offset = 0;
    text.split('\n').forEach((line, i) => {
      if ((ignoreCase ? line.toLowerCase() : line).includes(q)) {
        if (matches.length < cap) matches.push({ line: i + 1, offset });
        total++;
      }
      offset += enc.encode(line).length + 1;
    });
    return { total, matches };
  },
};

export class AgentOs {
  readonly fs: BoxFs;
  readonly settings: SettingsApi;
  readonly secrets: SecretsApi;
  readonly perms: Permissions;
  readonly procs: ProcTable & { onExit(fn: (pid: number) => void): () => void };
  readonly packages: BoxPackages;
  readonly kcore = kcore;
  readonly mcp: McpHub;
  readonly dev: { start(o: { root: string; port?: number; network?: boolean; ppid?: number }): Promise<DevInfo>; stop(port: number): Promise<boolean>; list(): Promise<DevInfo[]>; logs(port: number, o?: { after?: number; limit?: number }): Promise<DevLog[]> };
  readonly caps: PlatformCap[];
  readonly version: string;
  readonly rootKind: 'opfs' | 'memory';
  readonly ui: { call<T>(method: 'clipboard.read' | 'clipboard.write' | 'speak', ...args: unknown[]): Promise<T> } | null;
  /** The page that runs the built-in model for this agent, if the host gave one. */
  readonly builtinPrompt: AgentUi['builtinPrompt'] | undefined;
  /** The page driver for the `preview` tool, when the host has windows. */
  readonly preview: AgentUi['preview'] | undefined;
  /** Replies may contain ```ui blocks (the host renders them). */
  readonly uiBlocks: boolean;

  #box: BrowserBox;
  /** The agent's shells, reopened on a new box after setBox(). */
  readonly shells = new Set<Shell>();

  /** The box the agent works in. */
  get box(): BrowserBox {
    return this.#box;
  }

  /**
   * Moves the agent to a new connection to its box (e.g. after the window that
   * shared it closed). Shell sessions reopen there, in the same folders.
   */
  setBox(box: BrowserBox): void {
    this.#box = box;
    for (const s of this.shells) s.reset();
  }

  private constructor(
    box: BrowserBox,
    private opts: AgentOsOptions,
  ) {
    this.#box = box;
    this.procs = withExitEvents(opts.procs ?? new LocalProcs());
    this.fs = new BoxFs(() => this.#box);
    const given = opts.settings;
    this.settings = given && typeof (given as SettingsApi).get === 'function' && typeof (given as SettingsApi).keys === 'function' ? (given as SettingsApi) : new Settings(given as Record<string, unknown> | undefined, opts.onSettingsChange);
    if (!opts.prompter && !this.settings.keys().includes('perms.mode')) this.settings.set('perms.mode', 'auto');
    this.secrets = !opts.secrets ? new MapSecrets({}) : 'get' in opts.secrets && typeof opts.secrets.get === 'function' ? (opts.secrets as SecretsApi) : new MapSecrets(opts.secrets as Record<string, string>);
    this.perms = new Permissions(this.settings);
    if (opts.prompter) this.perms.setPrompter(opts.prompter);
    this.packages = new BoxPackages(() => this.#box);
    this.mcp = new McpHub(this);
    this.dev = { start: (o) => this.#box.dev.start(o.root, { port: o.port, network: o.network }), stop: (p) => this.#box.dev.stop(p), list: () => this.#box.dev.list(), logs: (p, o) => this.#box.dev.logs(p, o) };
    const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    this.caps = [...box.caps.filter((c) => c !== 'webgpu').map((id) => ({ id, label: id, ok: true })), { id: 'webgpu', label: 'WebGPU', ok: gpu }];
    this.version = box.version;
    if (opts.ui?.openApp) apps = opts.ui.apps ?? [];
    this.rootKind = box.storage;
    const ui = opts.ui ?? {};
    this.builtinPrompt = ui.builtinPrompt;
    this.preview = ui.preview;
    this.uiBlocks = !!ui.blocks;
    this.ui =
      ui.clipboardRead || ui.clipboardWrite || ui.speak
        ? {
            call: async <T>(method: string, ...args: unknown[]): Promise<T> => {
              if (method === 'clipboard.read' && ui.clipboardRead) return (await ui.clipboardRead()) as T;
              if (method === 'clipboard.write' && ui.clipboardWrite) return (await ui.clipboardWrite(String(args[0]))) as T;
              if (method === 'speak' && ui.speak) return ui.speak(String(args[0])) as T;
              throw new Error(`the app does not support ${method}`);
            },
          }
        : null;
  }

  /** Prepares the agent's view of a box (reads its package list). */
  static async create(box: BrowserBox, opts: AgentOsOptions = {}): Promise<AgentOs> {
    const os = new AgentOs(box, opts);
    await Promise.all([os.packages.refresh().catch(() => undefined), opts.seed === false ? null : os.#seed().catch(() => undefined)]);
    return os;
  }

  /** The model supplied in the options, if any. */
  customProvider(): Promise<Provider> | null {
    const p = this.opts.provider;
    return p ? Promise.resolve(typeof p === 'function' ? p() : p) : null;
  }

  /**
   * Example skills, agents and commands: all of them the first time an agent
   * works in this box, and later only ones it has never had (a new version's
   * skills), so a file the user deleted does not come back.
   */
  async #seed(): Promise<void> {
    const { SEED } = await import('../ext/library.js');
    const KEY = 'agent.seeded';
    let had = this.settings.get<string[] | null>(KEY, null);
    // Boxes seeded before this list was kept had the first four examples.
    if (!had && (await this.fs.exists(`${AGENT_HOME}/skills`))) had = ['skills/data-analysis/SKILL.md', 'skills/web-page/SKILL.md', 'agents/explorer.md', 'commands/explain.md'].map((p) => `${AGENT_HOME}/${p}`);
    const seen = new Set(had ?? []);
    const fresh = SEED.filter(([path]) => !seen.has(path));
    for (const [path, text] of fresh) if (!(await this.fs.exists(path))) await this.fs.writeFile(path, text);
    if (fresh.length || !had) this.settings.set(KEY, SEED.map(([path]) => path).concat([...seen].filter((p) => !SEED.some(([s]) => s === p))));
  }

  hasCap(id: string): boolean {
    return this.caps.some((c) => c.id === id && c.ok);
  }
  notify(notice: Notice | string): void {
    this.opts.ui?.notify?.(typeof notice === 'string' ? { title: notice } : notice);
  }
  openApp(id: string, args?: Record<string, unknown>): void {
    this.opts.ui?.openApp?.(id, args);
  }
  /** Apps the host can open, for open_app. */
  apps(): AppInfo[] {
    return this.opts.ui?.openApp ? (this.opts.ui.apps ?? []) : [];
  }
  /** The box's process table. */
  processes() {
    return this.box.processes();
  }
  killProcess(pid: number) {
    return this.box.killProcess(pid);
  }
}

/** The files part of a box or kernel that the agent's helpers need (sessions, extensions). */
export interface FilesLike {
  readText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<Array<{ path: string; name: string; kind: 'file' | 'dir'; size: number; mtime: number }>>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** Settings alone (model config) / settings and files (extensions, sessions): what an app's kernel client can pass to the helpers. */
export interface WithSettings {
  settings: SettingsApi;
}
export interface WithFiles {
  fs: FilesLike;
}

/** The names the agent's code uses for the kernel: here, the agent's view of a box. */
export type KernelCore = AgentOs;
export type Kernel = AgentOs;
export type FsApi = AgentOs['fs'];

/** Apps the host can open (open_app), registered when an AgentOs is created with `ui.openApp`. */
let apps: AppInfo[] = [];
export const listApps = (): readonly AppInfo[] => apps;

/** A shell variable map without the shell's own bookkeeping. */
export const userEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== '?'));

/**
 * The agent's own shell: a session in the box that keeps its working folder
 * and variables between commands, opened on first use.
 */
export class Shell {
  cwd: string;
  env: Record<string, string>;
  #session: Promise<BoxShell> | null = null;

  constructor(
    private os: AgentOs,
    opts: { cwd?: string } = {},
  ) {
    this.cwd = opts.cwd ?? HOME;
    this.env = { HOME, USER: 'user' };
    os.shells.add(this);
  }

  /** Forgets the session (the box changed); the next command opens a new one in the same folder. */
  reset(): void {
    this.#session = null;
  }

  #open(): Promise<BoxShell> {
    return (this.#session ??= this.os.box.openShell({ cwd: this.cwd }));
  }

  /** Runs a command line; output goes to `io` as it comes. Resolves with the exit code. */
  async run(line: string, io: { out(t: string): void; err(t: string): void; signal?: AbortSignal }): Promise<number> {
    const session = await this.#open();
    const p = await session.run(line);
    const kill = () => void p.kill();
    io.signal?.addEventListener('abort', kill);
    const pump = async (stream: ReadableStream<string>, to: (t: string) => void) => {
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        to(value);
      }
    };
    try {
      await Promise.all([pump(p.stdout, io.out), pump(p.stderr, io.err)]);
      return await p.exit;
    } finally {
      io.signal?.removeEventListener('abort', kill);
      this.cwd = session.cwd;
    }
  }

  /** Runs a command line and collects its output. */
  async exec(line: string, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await this.run(line, { out: (t) => (out += t), err: (t) => (err += t), signal });
    return { code, out, err };
  }

  close(): void {
    void this.#session?.then((s) => s.close()).catch(() => undefined);
    this.#session = null;
    this.os.shells.delete(this);
  }
}

/** Puts a value in single quotes for the box's shell. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A unique temporary file path in the box. */
export const tempPath = (name: string) => join('/tmp', `agent-${Math.random().toString(36).slice(2, 10)}-${basename(name)}`);
