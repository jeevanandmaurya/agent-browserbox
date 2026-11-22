import type { Bus } from './bus';
import type { DevApi } from './dev/types';
import type { PlatformCap } from './caps';
import type { KCore } from './kcore';
import type { Permissions } from './perms';
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
 *
 * Services built on top of the kernel add themselves to this interface by
 * module augmentation (see src/agent/api.ts, which adds `agents`), so the
 * kernel never depends on them.
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
