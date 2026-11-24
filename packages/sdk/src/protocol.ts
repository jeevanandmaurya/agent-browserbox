/**
 * The wire protocol between the SDK (in the embedding page) and the runtime
 * (a hidden iframe on the runtime's origin). Shared by both sides; bump
 * PROTOCOL_VERSION on any incompatible change.
 *
 * Handshake, over window.postMessage:
 *   runtime → parent   { type: 'bbx:embed-ready' }
 *   SDK → runtime      { type: 'bbx:connect', protocol }  + a MessagePort
 * Everything after that goes over the port: calls and results, process
 * output and exit, and permission questions.
 */
export const PROTOCOL_VERSION = 1;

export interface Hello {
  t: 'hello';
  protocol: number;
  /** Runtime version. */
  version: string;
  /** The box's id ('site' for the site's own kernel). */
  id: string;
  /** The default working directory for commands. */
  home: string;
  /** Platform features available in the runtime (e.g. 'opfs', 'webgpu'). */
  caps: string[];
  /** 'opfs' when files persist across reloads (per embedding site), 'memory' when not. */
  storage: 'opfs' | 'memory';
}

export interface Refused {
  t: 'refused';
  error: string;
}

export interface FileStat {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size: number;
  /** Last modified, ms since the epoch. */
  mtime: number;
}

export interface ExecOptions {
  /** Working directory. Default: the runtime's home. */
  cwd?: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /** Kill the command after this many ms (exit code 124). */
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type PermissionDecision = 'once' | 'always' | 'deny';

export interface PermissionRequest {
  /** What is asked for: 'fs.write', 'exec', 'net', 'clipboard', 'notify' or 'system'. */
  cap: string;
  /** Who is asking, e.g. a command. */
  actor: string;
  /** Short human title, e.g. "Network access". */
  title: string;
  /** The exact thing being approved (command, path, URL). */
  detail: string;
}

/** A shell session: keeps its working folder and variables between commands. */
export interface ShellInfo {
  id: number;
  cwd: string;
}

/** A process in the box's process table (shells, sandboxes, dev servers, …). */
export interface ProcessInfo {
  pid: number;
  ppid?: number;
  name: string;
  kind: string;
  /** 'running', 'idle', … */
  state: string;
  detail: string;
  /** When it started, ms since the epoch. */
  started: number;
  cpuMs: number;
  memBytes: number;
}

/** A dev server the box runs for a project folder. Nothing listens on a real port: `url` is virtual. */
export interface DevServer {
  port: number;
  root: string;
  url: string;
  /** The project's request handler (server.ts, …), if it has one. */
  backend: string | null;
  network: boolean;
}

export interface DevLogEntry {
  /** Increasing per server; pass the last one as `after` to get newer entries. */
  seq: number;
  t: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** page: the app's console · server: the backend · build: bundling · network: failed requests. */
  source: 'page' | 'server' | 'build' | 'network';
  text: string;
}

/** A port to the kernel, and what its client needs to know. */
export interface KernelChannel {
  port: MessagePort;
  /** The Web Lock the runtime holds while this connection lives. */
  lock: string;
  /** False when the browser has no SharedWorker (one kernel per page). */
  shared: boolean;
}

/** A file an overlay changed, by its path inside the overlay. */
export interface OverlayChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
}

/** Calls the SDK can make, with their arguments and results. */
export interface Methods {
  info(): Hello;
  'fs.readFile'(path: string): Uint8Array;
  'fs.readTextFile'(path: string): string;
  'fs.writeFile'(path: string, data: string | Uint8Array): void;
  'fs.mkdir'(path: string): void;
  'fs.readdir'(path: string): FileStat[];
  'fs.stat'(path: string): FileStat | null;
  'fs.exists'(path: string): boolean;
  'fs.rm'(path: string, opts?: { recursive?: boolean }): void;
  'fs.rename'(from: string, to: string): void;
  'fs.cp'(from: string, to: string): void;
  'fs.appendFile'(path: string, data: string | Uint8Array): void;
  /** Absolute paths of the files under `cwd` that match a glob ('**', '*', '?', '{a,b}'). */
  'fs.glob'(pattern: string, cwd?: string, limit?: number): string[];
  /** Mounts a copy-on-write view of the folder `lower` at `point`; changes stay in `store` until applied or discarded. */
  'fs.overlay'(point: string, lower: string, store: string): void;
  'fs.overlayChanges'(point: string): OverlayChange[];
  'fs.overlayApply'(point: string, paths?: string[]): string[];
  'fs.overlayDiscard'(point: string, paths?: string[]): void;
  'shell.open'(opts?: { cwd?: string; env?: Record<string, string> }): ShellInfo;
  /** Runs a command line in a shell session; output and exit (with the new cwd) arrive as events. Returns its process id. */
  'shell.run'(id: number, command: string, opts?: { timeoutMs?: number }): number;
  'shell.close'(id: number): void;
  'dev.start'(opts: { root: string; port?: number; network?: boolean }): DevServer;
  'dev.stop'(port: number): boolean;
  'dev.list'(): DevServer[];
  'dev.logs'(port: number, opts?: { after?: number; limit?: number }): DevLogEntry[];
  'procs.list'(): ProcessInfo[];
  'procs.kill'(pid: number): boolean;
  /**
   * A port to the box's kernel itself, speaking its full internal protocol:
   * for app UIs that need more than this API. Versioned with the runtime.
   */
  'kernel.connect'(): KernelChannel;
  /** A second connection to this box (its own shells and processes), e.g. for a worker. */
  share(): MessagePort;
  exec(command: string, opts?: ExecOptions): ExecResult;
  /** Starts a command; its output and exit arrive as events. Returns its process id. */
  spawn(command: string, opts?: ExecOptions): number;
  kill(pid: number): boolean;
}

export type Method = keyof Methods;

/** SDK → runtime. */
export type ToRuntime =
  | { t: 'call'; id: number; method: Method; args: unknown[] }
  | { t: 'permission-answer'; id: number; decision: PermissionDecision };

/** Runtime → SDK. */
export type FromRuntime =
  | Hello
  | Refused
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string; code?: string }
  | { t: 'output'; pid: number; stream: 'stdout' | 'stderr'; data: string }
  /** `cwd`: for commands run in a shell session, its working folder afterwards. */
  | { t: 'exit'; pid: number; exitCode: number; cwd?: string }
  | { t: 'permission'; id: number; request: PermissionRequest };
