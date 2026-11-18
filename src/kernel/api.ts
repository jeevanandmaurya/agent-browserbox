import type { AgentEvent } from '@/agent/agent';
import type { TodoItem } from '@/agent/tools/types';
import type { ContextReport, Msg, Usage } from '@/agent/types';
import type { Bus } from './bus';
import type { DevApi } from './dev/types';
import type { FileDiff } from '@/agent/diff';
import type { PlatformCap } from './caps';
import type { KCore } from './kcore';
import type { Permissions, Prompter } from './perms';
import type { Proc, SpawnOptions } from './proc';
import type { KernelEvents, Notice } from './types';
import type { Stat } from './vfs/types';

/**
 * The kernel's public surface. Two things implement it:
 *  - `KernelCore`, the real kernel, which runs headless in a worker;
 *  - `RemoteKernel`, a client in each window that mirrors read-mostly state
 *    and forwards everything else over RPC.
 * Apps, the shell and the agent are written against this interface only,
 * which is what lets any GUI (or none) sit in front of the same kernel.
 */
export interface Kernel {
  readonly version: string;
  readonly bus: Bus<KernelEvents>;
  readonly settings: SettingsApi;
  readonly secrets: SecretsApi;
  readonly perms: Permissions;
  readonly procs: ProcsApi;
  readonly fs: FsApi;
  readonly kcore: KCore;
  readonly agents: AgentsApi;
  readonly shells: ShellsApi;
  /** Virtual dev servers for project folders (`serve`). */
  readonly dev: DevApi;
  readonly caps: PlatformCap[];
  rootKind: 'opfs' | 'memory';
  readonly bootStart: number;
  readonly bootMarks: Array<{ name: string; at: number }>;
  mark(name: string): void;
  hasCap(id: string): boolean;
  notify(notice: Notice | string): void;
  openApp(id: string, args?: Record<string, unknown>): void;
  mountNativeFolder(): Promise<string>;
}

export interface MountInfo {
  point: string;
  fs: { label: string; readonly?: boolean };
}

export interface FsApi {
  readonly ready: Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<Stat[]>;
  stat(path: string): Promise<Stat | null>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  cp(from: string, to: string): Promise<void>;
  mv(from: string, to: string): Promise<void>;
  glob(pattern: string, cwd?: string, limit?: number): Promise<string[]>;
  walk(root: string, opts?: { maxDepth?: number; signal?: AbortSignal }): AsyncGenerator<Stat>;
  mounts(): readonly MountInfo[];
  unmount(point: string): void;
}

export interface ProcsApi {
  spawn(opts: SpawnOptions): Proc;
  update(pid: number, patch: Partial<Pick<Proc, 'state' | 'detail' | 'memBytes'>>): void;
  account(pid: number, ms: number): void;
  kill(pid: number, reason?: string): boolean;
  exit(pid: number): void;
  get(pid: number): Proc | undefined;
  list(): Proc[];
}

export interface SettingsApi {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

/** Windows can store and remove secrets but never read them back; only the kernel uses them. */
export interface SecretsApi {
  has(name: string): Promise<boolean>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

// ---- Agent sessions ---------------------------------------------------------

export interface AgentSnapshot {
  sid: string;
  private: boolean;
  pid: number;
  busy: boolean;
  title: string;
  /** The full conversation (never shortened by compaction). */
  messages: Msg[];
  todos: TodoItem[];
  total: Usage;
  context: ContextReport;
  /** What each file tool call changed, by tool call id. */
  diffs: Record<string, FileDiff>;
}

/** The files one turn changed, with their content before (null: created by the agent, or binary/too large). */
export interface TurnChanges {
  /** Transcript index of the user message that started the turn. */
  turn: number;
  at: number;
  files: Array<{ path: string; before: string | null; existed: boolean; binary: boolean; skipped: boolean }>;
}

export interface AgentInfo {
  sid: string;
  pid: number;
  busy: boolean;
  title: string;
}

/** A window's view of an agent session that lives in the kernel. */
export interface AgentHandle {
  readonly sid: string;
  readonly pid: number;
  /** Resolves when the agent has finished responding. `plan`: look, change nothing, answer with a plan. */
  send(text: string, opts?: { plan?: boolean }): Promise<void>;
  /** Back to just before the user message at transcript index `index`; with `files`, undoing the agent's file changes since. */
  rewind(index: number, files: boolean): Promise<{ restored: string[]; skipped: string[] }>;
  /** The files each turn changed (file tools only). */
  changes(): Promise<TurnChanges[]>;
  stop(): void;
  snapshot(): Promise<AgentSnapshot>;
  /** Where the context window is going. */
  context(): Promise<ContextReport>;
  /** Summarise the conversation now to free context. Resolves false if nothing was done. */
  compact(): Promise<boolean>;
  onEvent(fn: (e: AgentEvent) => void): () => void;
  /** Supplies answers to the agent's ask_user questions. */
  onAsk(fn: (question: string, options?: string[]) => Promise<string>): void;
  /** Overrides the permission dialog for this session (e.g. a terminal y/n prompt). */
  prompter?: Prompter;
  /** Stop observing. The session keeps running in the kernel. */
  detach(): void;
  /** End the session and its process. */
  dispose(): void;
}

export interface AgentsApi {
  /** `resume` loads a saved session file by id. */
  create(opts?: { resume?: string; ppid?: number; private?: boolean }): Promise<AgentHandle>;
  attach(sid: string): Promise<AgentHandle>;
  /** Sessions currently alive in the kernel, most recent first. */
  live(): Promise<AgentInfo[]>;
  /** Lists models on an OpenAI-compatible server, using the stored API key if any. */
  probeModels(baseUrl: string, kind?: 'local' | 'openai'): Promise<string[]>;
  /** Connects to a configured MCP server and lists its tools. */
  probeMcp(name: string): Promise<Array<{ name: string; description: string }>>;
}

// ---- Shell sessions ---------------------------------------------------------

export interface ShellIo {
  out(text: string): void;
  err(text: string): void;
  signal?: AbortSignal;
}

export interface ShellHandle {
  readonly id: string;
  /** Current directory; refreshed after every command. */
  cwd: string;
  readonly home: string;
  run(line: string, io: ShellIo): Promise<number>;
  complete(line: string): Promise<{ start: number; options: string[] }>;
  /** Supplies interactive input when a command reads from the terminal. */
  onReadLine(fn: (prompt: string, secret: boolean) => Promise<string | null>): void;
  onClear(fn: () => void): void;
  close(): void;
}

export interface ShellsApi {
  open(opts?: { cwd?: string; ppid?: number }): Promise<ShellHandle>;
}
