import type { DevInfo, DevLog } from './dev/types';
import type { Proc } from './proc';

export interface FsChange {
  path: string;
  type: 'write' | 'remove' | 'mkdir' | 'mount';
}

export interface KernelLogLine {
  /** Milliseconds since the kernel started. */
  t: number;
  src: string;
  msg: string;
}

export interface Notice {
  title: string;
  body?: string;
  level?: 'info' | 'ok' | 'warn' | 'error';
}

/** Every event that can cross module boundaries. */
/** A profile's password lock: 'open' (no password), 'locked' (signed out) or 'unlocked' (signed in). */
export type LockState = 'open' | 'locked' | 'unlocked';

/**
 * Something a command asks of the terminal it runs in, which only the window
 * showing that terminal can do: close it (`exit`), or open another profile.
 */
export type ShellAction = { kind: 'exit'; code: number } | { kind: 'profile'; id: string };

export interface KernelEvents extends Record<string, unknown> {
  'fs:change': FsChange;
  'proc:spawn': Proc;
  'proc:update': Proc;
  'proc:exit': { proc: Proc; reason: string };
  'settings:change': { key: string; value: unknown };
  /** The profile was signed in or out, or its password changed. */
  'secrets:lock': { state: LockState };
  notify: Notice;
  /** A line was added to the kernel log. */
  kmsg: KernelLogLine;
  /** Ask the shell UI to launch an app. */
  /** `fromWindow`: raised by a GUI window (e.g. the desktop), not by the kernel, the shell or the agent. */
  'app:open': { id: string; args?: Record<string, unknown>; fromWindow?: boolean };
  /** Dev servers started or stopped. */
  'dev:update': DevInfo[];
  /** A dev server recorded output (page console, backend, build, network). */
  'dev:log': { port: number; entry: DevLog };
}
