import type { Bus } from './bus';
import type { DevApi } from './dev/types';
import type { PlatformCap } from './caps';
import type { KCore } from './kcore';
import type { Permissions, Prompter } from './perms';
import type { Proc, SpawnOptions } from './proc';
import type { KernelEvents, LockState, Notice, ShellAction } from './types';
import type { PasskeyInfo } from './secrets';
import type { ExternalPackage, InstalledExternal, Listed, PackageInfo, PackageSource } from './package-types';
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
  /** The package manager, for a person's window (Settings → Packages). Not offered to the agent or SDK clients. */
  readonly pkg?: PackagesApi;
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

/** A package from an index, as a window sees it. */
export type IndexedPackage = Listed & { installedVersion?: string };

/**
 * The package manager for a person in a window. Installing from a source other
 * than the BrowserBox index is the person's choice: the window asks first.
 */
export interface PackagesApi {
  /** The built-in packages (python, git, …), with size and whether installed. */
  builtin(): Promise<PackageInfo[]>;
  /** Every package in the sources' indexes (`refresh` fetches them again). */
  index(refresh?: boolean): Promise<IndexedPackage[]>;
  /** Installed packages from sources. */
  installed(): Promise<InstalledExternal[]>;
  /** Installs a built-in package, or one from an index (`id` or `id@version`) with what it needs. Returns what was installed. */
  install(id: string): Promise<string[]>;
  /** Fetches and checks a package description from a link (shown to the person before `installFrom`). */
  describeUrl(url: string): Promise<ExternalPackage>;
  /** Installs the package described at a link. */
  installFrom(url: string): Promise<string[]>;
  /** Removes a package (refused while another needs it, unless `force`). */
  remove(id: string, o?: { force?: boolean }): Promise<void>;
  dependents(id: string): Promise<string[]>;
  upgradable(): Promise<Array<{ id: string; from: string; to: Listed }>>;
  verify(): Promise<Array<{ id: string; path: string; problem: 'missing' | 'changed' }>>;
  sources(): Promise<PackageSource[]>;
  addSource(url: string): Promise<void>;
  removeSource(url: string): Promise<void>;
}

/** Windows can store and remove secrets but never read them back; only the kernel uses them. */
export interface SecretsApi {
  has(name: string): Promise<boolean>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** The profile's password lock: 'open' (no password), 'locked' (signed out) or 'unlocked'. */
  status(): Promise<LockState>;
  /** Signs in; false when the password is wrong. */
  unlock(password: string): Promise<boolean>;
  /** Signs out: the keys stay encrypted until the next unlock. */
  lock(): Promise<void>;
  /** Sets or changes the password (`null` removes it). Needs the keys unlocked. Removes the profile's passkeys. */
  setPassword(password: string | null): Promise<void>;
  /** Passkeys that unlock the profile (WebAuthn PRF), with what to evaluate their PRF on. */
  passkeys?(): Promise<PasskeyInfo[]>;
  /** Adds a passkey the window made; `prf` is its PRF output for `input`. False when the password is wrong. */
  addPasskey?(password: string, p: { id: string; label: string; input: Uint8Array<ArrayBuffer>; prf: Uint8Array<ArrayBuffer> }): Promise<boolean>;
  /** Signs in with a passkey's PRF output; false when it does not match. */
  unlockWithPasskey?(id: string, prf: Uint8Array<ArrayBuffer>): Promise<boolean>;
  removePasskey?(id: string): Promise<void>;
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
  /** What commands ask of the terminal: close it, open another profile. */
  onAction?(fn: (action: ShellAction) => void): void;
  close(): void;
}

/** A command run by someone else (a kernel client), offered in every shell. */
export interface ContributedCommand {
  name: string;
  summary: string;
  usage?: string;
  /** Where `help` lists it. */
  section?: string;
  /** `interactive`: a person is typing in this terminal (not the agent or a script). */
  run(io: { args: string[]; stdin: string; cwd: string; out(text: string): void; err(text: string): void; signal: AbortSignal; readLine?(prompt: string, secret: boolean): Promise<string | null>; interactive?: boolean }): Promise<number>;
}

export interface ShellsApi {
  /** Offers a command in every shell; returns a function that withdraws it. (Kernel side only.) */
  contribute?(cmd: ContributedCommand): () => void;
  /**
   * `confined`: the shell runs code for someone else (the SDK runtime), so network access needs a permission grant.
   * `prompter`: who answers its permission requests (kernel side only; it cannot cross RPC).
   */
  open(opts?: { cwd?: string; ppid?: number; confined?: boolean; prompter?: Prompter }): Promise<ShellHandle>;
}
