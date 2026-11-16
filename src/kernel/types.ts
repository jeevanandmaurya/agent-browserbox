import type { Proc } from './proc';

export interface FsChange {
  path: string;
  type: 'write' | 'remove' | 'mkdir' | 'mount';
}

export interface Notice {
  title: string;
  body?: string;
  level?: 'info' | 'ok' | 'warn' | 'error';
}

/** Every event that can cross module boundaries. */
export interface KernelEvents extends Record<string, unknown> {
  'fs:change': FsChange;
  'proc:spawn': Proc;
  'proc:update': Proc;
  'proc:exit': { proc: Proc; reason: string };
  'settings:change': { key: string; value: unknown };
  notify: Notice;
  /** Ask the shell UI to launch an app. */
  'app:open': { id: string; args?: Record<string, unknown> };
}
