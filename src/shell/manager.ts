import type { ShellHandle, ShellIo, ShellsApi } from '@/kernel/api';
import type { KernelCore } from '@/kernel/kernel';
import type { Prompter } from '@/kernel/perms';
import { registerCommands } from './index';
import { Shell } from './shell';

/** Shell sessions run in the kernel as processes; a terminal is just a view onto one. */
export class ShellManager implements ShellsApi {
  #next = 1;

  constructor(private os: KernelCore) {}

  async open(opts: { cwd?: string; ppid?: number; confined?: boolean; prompter?: Prompter } = {}): Promise<ShellHandle> {
    const os = this.os;
    let reader: ((prompt: string, secret: boolean) => Promise<string | null>) | null = null;
    let clear: (() => void) | null = null;
    let running: AbortController | null = null;
    const proc = os.procs.spawn({ name: 'bbsh', kind: 'shell', ppid: opts.ppid, onKill: () => running?.abort() });
    os.procs.update(proc.pid, { state: 'idle' });
    const shell = registerCommands(
      new Shell(os, {
        cwd: opts.cwd,
        ppid: proc.pid,
        confined: opts.confined,
        prompter: opts.prompter,
        tty: { readLine: (prompt, o) => (reader ? reader(prompt, o?.secret ?? false) : Promise.resolve(null)), clear: () => clear?.() },
      }),
    );
    const handle: ShellHandle = {
      id: `sh${this.#next++}`,
      cwd: shell.cwd,
      home: shell.env.HOME ?? '/',
      async run(line: string, io: ShellIo): Promise<number> {
        if (proc.signal.aborted) throw new Error('this shell has exited');
        if (line.trim() && shell.history.at(-1) !== line) shell.history.push(line);
        running = new AbortController();
        const abort = () => running?.abort();
        io.signal?.addEventListener('abort', abort);
        os.procs.update(proc.pid, { state: 'running', detail: line.slice(0, 60) });
        const started = performance.now();
        try {
          return await shell.run(line, { out: io.out, err: io.err, signal: running.signal });
        } finally {
          io.signal?.removeEventListener('abort', abort);
          running = null;
          handle.cwd = shell.cwd;
          os.procs.account(proc.pid, performance.now() - started);
          os.procs.update(proc.pid, { state: 'idle', detail: shell.cwd });
        }
      },
      complete: (line) => shell.complete(line),
      onReadLine(fn) {
        reader = fn;
      },
      onClear(fn) {
        clear = fn;
      },
      close: () => os.procs.exit(proc.pid),
    };
    return handle;
  }
}
