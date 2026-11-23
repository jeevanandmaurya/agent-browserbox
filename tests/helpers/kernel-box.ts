import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { KernelCore } from '../../src/kernel/kernel';
import { HOME } from '../../src/kernel/paths';
import { MemFs } from '../../src/kernel/vfs/memfs';
import { registerCommands } from '../../src/shell/index';
import { plainText } from '../../src/shell/ansi';
import { Shell } from '../../src/shell/shell';

/**
 * A real kernel (in memory, in this process) behind the SDK's BrowserBox
 * interface, for tests that run the agent package without a browser.
 */
export async function kernelBox(): Promise<{ kernel: KernelCore; box: BrowserBox }> {
  const kernel = new KernelCore();
  kernel.fs.mount('/', new MemFs());
  kernel.fs.markReady();
  await Promise.all([kernel.fs.mkdir(HOME), kernel.fs.mkdir('/home/agent'), kernel.fs.mkdir('/tmp')]);
  const fs = kernel.fs;
  const stream = () => {
    let push!: (t: string) => void;
    let end!: () => void;
    const s = new ReadableStream<string>({ start: (c) => ((push = (t) => c.enqueue(t)), (end = () => c.close())) });
    return { s, push, end };
  };
  const runIn = (shell: Shell, line: string) => {
    const out = stream();
    const err = stream();
    const ctl = new AbortController();
    const exit = shell.run(line, { out: out.push, err: err.push, signal: ctl.signal }).finally(() => (out.end(), err.end()));
    return { pid: 0, output: out.s, stdout: out.s, stderr: err.s, exit, kill: async () => (ctl.abort(), true) };
  };
  const box = {
    home: HOME,
    storage: 'memory',
    version: 'test',
    caps: ['opfs'],
    fs: {
      readFile: (p: string) => fs.readFile(p),
      readTextFile: (p: string) => fs.readText(p),
      writeFile: (p: string, d: string | Uint8Array) => fs.writeFile(p, d),
      appendFile: (p: string, d: string | Uint8Array) => fs.appendFile(p, d),
      readdir: (p: string) => fs.readdir(p),
      stat: (p: string) => fs.stat(p),
      exists: (p: string) => fs.exists(p),
      mkdir: (p: string) => fs.mkdir(p),
      rm: (p: string, o?: { recursive?: boolean }) => fs.rm(p, o),
      rename: (a: string, b: string) => fs.mv(a, b),
      cp: (a: string, b: string) => fs.cp(a, b),
      glob: (pattern: string, o: { cwd?: string; limit?: number } = {}) => fs.glob(pattern, o.cwd ?? HOME, o.limit),
    },
    async exec(line: string, o: { cwd?: string } = {}) {
      const shell = registerCommands(new Shell(kernel, { cwd: o.cwd }));
      let stdout = '';
      let stderr = '';
      const exitCode = await shell.run(line, { out: (t) => (stdout += t), err: (t) => (stderr += t) });
      return { exitCode, stdout: plainText(stdout), stderr: plainText(stderr) };
    },
    async openShell(o: { cwd?: string } = {}) {
      const shell = registerCommands(new Shell(kernel, { cwd: o.cwd }));
      const session = {
        get cwd() {
          return shell.cwd;
        },
        run: async (line: string) => runIn(shell, line),
        close: async () => undefined,
      };
      return session;
    },
    processes: async () => kernel.procs.list().map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, kind: p.kind, state: p.state, detail: p.detail, started: p.started, cpuMs: p.cpuMs, memBytes: p.memBytes })),
    killProcess: async (pid: number) => kernel.procs.kill(pid),
    dev: {
      start: (root: string, o: { port?: number; network?: boolean } = {}) => kernel.dev.start({ root, ...o }),
      stop: (port: number) => kernel.dev.stop(port),
      list: () => kernel.dev.list(),
      logs: (port: number, o?: { after?: number; limit?: number }) => kernel.dev.logs(port, o),
    },
  };
  return { kernel, box: box as unknown as BrowserBox };
}
