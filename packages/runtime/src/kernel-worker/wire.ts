import type { Proc } from '../kernel/proc';
import type { KernelLogLine } from '../kernel/types';

/**
 * The kernel protocol's message types, shared by the kernel server and its
 * clients (RemoteKernel). Types only, so a client does not pull in the kernel.
 */
/** What a window receives when it connects. */
export interface Hello {
  clientId: number;
  /** Pids this client may allocate for its own processes start here. */
  pidBase: number;
  version: string;
  rootKind: 'opfs' | 'memory';
  shared: boolean;
  settings: Array<[string, unknown]>;
  procs: WireProc[];
  mounts: Array<{ point: string; label: string; readonly: boolean }>;
  bootMarks: Array<{ name: string; at: number }>;
  log: KernelLogLine[];
}

/** Each window allocates pids for its own processes from a private block. */
export const PID_BLOCK = 100_000;

export type WireProc = Omit<Proc, 'signal'>;
export type AskKind = 'perm' | 'user' | 'tty' | 'ui';
export interface Ask {
  askId: number;
  kind: AskKind;
  sid?: string;
  shellId?: string;
  payload: unknown;
}
