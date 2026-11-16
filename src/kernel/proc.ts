import type { Bus } from './bus';
import type { KernelEvents } from './types';

export type ProcKind = 'service' | 'app' | 'shell' | 'agent' | 'sandbox';
export type ProcState = 'running' | 'idle' | 'blocked';

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly kind: ProcKind;
  readonly started: number;
  state: ProcState;
  /** Free-form status line shown by `ps` and the Task Manager. */
  detail: string;
  /** Accumulated busy time in ms, reported by the owner via `account()`. */
  cpuMs: number;
  /** Best-effort memory attribution in bytes (0 = unknown). */
  memBytes: number;
  readonly signal: AbortSignal;
}

export interface SpawnOptions {
  name: string;
  kind: ProcKind;
  ppid?: number;
  detail?: string;
  /** Register under a pid allocated by a remote owner (a window's own processes). */
  pid?: number;
  /** Called when the process is killed or exits; release resources here. */
  onKill?: () => void;
}

/** The process table. A "process" is anything with a lifecycle the user can inspect and kill. */
export class ProcTable {
  #next = 1;
  #procs = new Map<number, { proc: Proc; ctl: AbortController; onKill?: () => void }>();

  constructor(private bus: Bus<KernelEvents>) {}

  spawn(opts: SpawnOptions): Proc {
    const ctl = new AbortController();
    const proc: Proc = {
      pid: opts.pid ?? this.#next++,
      ppid: opts.ppid ?? 0,
      name: opts.name,
      kind: opts.kind,
      started: Date.now(),
      state: 'running',
      detail: opts.detail ?? '',
      cpuMs: 0,
      memBytes: 0,
      signal: ctl.signal,
    };
    this.#procs.set(proc.pid, { proc, ctl, onKill: opts.onKill });
    this.bus.emit('proc:spawn', proc);
    return proc;
  }

  /** Update mutable fields and notify observers. */
  update(pid: number, patch: Partial<Pick<Proc, 'state' | 'detail' | 'memBytes'>>): void {
    const e = this.#procs.get(pid);
    if (!e) return;
    Object.assign(e.proc, patch);
    this.bus.emit('proc:update', e.proc);
  }

  account(pid: number, ms: number): void {
    const e = this.#procs.get(pid);
    if (e) e.proc.cpuMs += ms;
  }

  /** Terminates a process and (recursively) its children. Returns false if no such pid. */
  kill(pid: number, reason = 'killed'): boolean {
    const e = this.#procs.get(pid);
    if (!e) return false;
    this.#procs.delete(pid);
    for (const child of this.list()) if (child.ppid === pid) this.kill(child.pid, reason);
    e.ctl.abort(new DOMException(reason, 'AbortError'));
    try {
      e.onKill?.();
    } catch (err) {
      console.error(`[proc] onKill for ${e.proc.name} threw`, err);
    }
    this.bus.emit('proc:exit', { proc: e.proc, reason });
    return true;
  }

  /** Normal termination — same cleanup path as kill. */
  exit(pid: number): void {
    this.kill(pid, 'exit');
  }

  get(pid: number): Proc | undefined {
    return this.#procs.get(pid)?.proc;
  }

  list(): Proc[] {
    return [...this.#procs.values()].map((e) => e.proc);
  }
}
