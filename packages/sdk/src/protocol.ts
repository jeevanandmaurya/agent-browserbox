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
  /** The box's id. */
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
  | { t: 'exit'; pid: number; exitCode: number }
  | { t: 'permission'; id: number; request: PermissionRequest };
