import { report, userEnv } from '@/agent/tools/exec';
import { obj, tool } from '@/agent/tools/types';
import { runPython } from '@/sandbox/sandbox';
import type { Command, CommandContext } from '@/shell/shell';
import { flags } from '@/shell/shell';
import type { PackageModule } from '../types';

function finish(ctx: CommandContext, r: Awaited<ReturnType<typeof runPython>>): number {
  if (r.value !== undefined && r.value !== 'None') ctx.out(r.value + '\n');
  if (r.error) ctx.err(r.error + '\n');
  return r.ok ? 0 : 1;
}

const python: Command = {
  name: 'python',
  summary: 'run Python (CPython on WebAssembly)',
  usage: 'python file.py  |  python -c "code"   (files in the cwd are visible; changes are written back)',
  async run(ctx) {
    const { opts, rest } = flags(ctx.args);
    const code = opts.has('c') ? (rest[0] ?? '') : rest[0] ? await ctx.os.fs.readText(ctx.path(rest[0])) : ctx.stdin;
    if (!code.trim()) throw new Error('nothing to run: pass a file, -c "code", or pipe code in');
    return finish(ctx, await runPython(ctx.os, code, { cwd: ctx.shell.cwd, env: userEnv(ctx.shell.env), signal: ctx.signal, onStdout: ctx.out, onStderr: ctx.err }));
  },
};

export default {
  commands: [python, { ...python, name: 'python3' }],
  tools: [
    tool<{ code: string; packages?: string[] }>({
      name: 'run_python',
      description:
        'Run Python 3 (CPython compiled to WebAssembly via Pyodide) in an isolated sandbox. Files in the working directory are visible to the script and files it writes are saved back. Imports of bundled scientific packages (numpy, pandas, matplotlib, scipy, sympy…) load automatically; list pure-Python PyPI packages in `packages`. The interpreter persists between calls. No sockets or subprocesses.',
      input_schema: obj({ code: { type: 'string' }, packages: { type: 'array', items: { type: 'string' }, description: 'extra PyPI packages to install with micropip' } }, ['code']),
      cap: () => 'exec',
      describe: (i) => i.code,
      async run(i, tc) {
        return report(await runPython(tc.os, i.code, { cwd: tc.shell.cwd, env: userEnv(tc.shell.env), packages: i.packages, signal: tc.signal, onStdout: tc.progress, onStderr: tc.progress }));
      },
    }),
  ],
} satisfies PackageModule;
