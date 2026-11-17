import { stripAnsi } from '@/shell/ansi';
import { gpuCompute } from '@/sandbox/gpu';
import { runJs, runPython, runWasm, type RunResult } from '@/sandbox/sandbox';
import { clip, obj, tool, type ToolDef } from './types';

/** Shell variables minus the shell's own bookkeeping. */
export const userEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== '?'));

function report(r: RunResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.value !== undefined) parts.push(`[return value]\n${r.value}`);
  if (r.error) parts.push(`[error]\n${r.error}`);
  if (r.exitCode !== undefined && r.exitCode !== 0) parts.push(`[exit code ${r.exitCode}]`);
  const text = clip(parts.join('\n') || '(no output)');
  if (!r.ok) throw new Error(text);
  return text;
}

export const execTools: ToolDef[] = [
  tool<{ command: string }>({
    name: 'shell',
    description:
      'Run a command line in the BrowserBox shell (not bash, but POSIX-flavoured): pipes, redirects, &&, ||, ;, $VARS and globs work. Commands include ls, cat, grep, find, head, tail, wc, sort, uniq, mkdir, rm, cp, mv, tree, du, curl, js, python, wasm, gpu, ps, kill, open, sha256sum, gzip. Run `help` to list them all. Installed tool packs add more (git, sqlite3, zip/unzip — see `pkg list`). The working directory persists between calls (cd works). There is no npm, apt or native compiler.',
    input_schema: obj({ command: { type: 'string' } }, ['command']),
    cap: () => 'exec',
    describe: (i) => i.command,
    async run(i, tc) {
      let out = '';
      const sink = (t: string) => {
        out += t;
        tc.progress(t);
      };
      const code = await tc.shell.run(i.command, { out: sink, err: sink, signal: tc.signal });
      const text = clip(stripAnsi(out).trimEnd() || '(no output)');
      if (code !== 0) throw new Error(`${text}\n[exit code ${code}]`);
      return text;
    },
  }),
  tool<{ code: string; network?: boolean; timeout_ms?: number }>({
    name: 'run_js',
    description:
      'Run JavaScript in an isolated sandbox (a Worker in an opaque-origin frame; no DOM). The code is the body of an async function: use await and return a value. Globals: `fs` (async: readText, readFile, writeFile, appendFile, readdir, exists, mkdir, rm, glob — paths relative to the working directory), `print(...)`, `console`. fetch only works when network is true, and then only for CORS-enabled URLs. Good for computation, data processing and generating files.',
    input_schema: obj({ code: { type: 'string' }, network: { type: 'boolean', description: 'allow outbound network (asks the user)' }, timeout_ms: { type: 'integer', description: 'default 30000, max 300000' } }, ['code']),
    cap: (i) => (i.network ? 'net' : 'exec'),
    describe: (i) => `${i.network ? '[network] ' : ''}${i.code}`,
    async run(i, tc) {
      return report(await runJs(tc.os, i.code, { cwd: tc.shell.cwd, env: userEnv(tc.shell.env), network: i.network, timeoutMs: Math.min(i.timeout_ms ?? 30000, 300000), signal: tc.signal, onStdout: tc.progress, onStderr: tc.progress, ppid: tc.pid }));
    },
  }),
  tool<{ code: string; packages?: string[] }>({
    name: 'run_python',
    description:
      'Run Python 3 (CPython compiled to WebAssembly via Pyodide) in an isolated sandbox. Files in the working directory are visible to the script and files it writes are saved back. Imports of bundled scientific packages (numpy, pandas, matplotlib, scipy, sympy…) load automatically; list pure-Python PyPI packages in `packages`. The first run downloads the runtime and takes several seconds. The interpreter persists between calls. No sockets or subprocesses.',
    input_schema: obj({ code: { type: 'string' }, packages: { type: 'array', items: { type: 'string' }, description: 'extra PyPI packages to install with micropip' } }, ['code']),
    cap: () => 'exec',
    describe: (i) => i.code,
    async run(i, tc) {
      await tc.os.packs.ensure('python', (loaded, bytes) => bytes && tc.progress(`downloading Python runtime: ${Math.round((loaded / bytes) * 100)}%\n`));
      return report(await runPython(tc.os, i.code, { cwd: tc.shell.cwd, env: userEnv(tc.shell.env), packages: i.packages, signal: tc.signal, onStdout: tc.progress, onStderr: tc.progress }));
    },
  }),
  tool<{ path: string; args?: string[]; stdin?: string }>({
    name: 'run_wasm',
    description: 'Run a WebAssembly program (WASI preview1, stdio only) from a .wasm file in the filesystem. Returns its stdout, stderr and exit code.',
    input_schema: obj({ path: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } }, ['path']),
    cap: () => 'exec',
    describe: (i) => `Run ${i.path} ${(i.args ?? []).join(' ')}`,
    async run(i, tc) {
      const bytes = await tc.os.fs.readFile(tc.path(i.path));
      return report(await runWasm(tc.os, bytes, { name: i.path, args: i.args, stdin: i.stdin, signal: tc.signal, onStdout: tc.progress, onStderr: tc.progress, ppid: tc.pid }));
    },
  }),
  tool<{ wgsl: string; input?: number[]; input_file?: string; output_length: number; workgroups?: number[]; output_file?: string }>({
    name: 'gpu_compute',
    description:
      'Run a WGSL compute shader on the GPU with WebGPU. The shader must define `@compute @workgroup_size(...) fn main(...)`, with `@group(0) @binding(0) var<storage, read> input: array<f32>;` and `@group(0) @binding(1) var<storage, read_write> output: array<f32>;`. Input comes from `input` (numbers) or `input_file` (a JSON array). Returns the first values and summary statistics; use output_file to save the full result as JSON.',
    input_schema: obj(
      {
        wgsl: { type: 'string' },
        input: { type: 'array', items: { type: 'number' } },
        input_file: { type: 'string' },
        output_length: { type: 'integer', description: 'number of f32 values in the output buffer' },
        workgroups: { type: 'array', items: { type: 'integer' }, description: '[x, y?, z?] dispatch counts; default ceil(output_length / 64)' },
        output_file: { type: 'string' },
      },
      ['wgsl', 'output_length'],
    ),
    cap: () => 'exec',
    describe: (i) => `GPU compute → ${i.output_length} values`,
    async run(i, tc) {
      const input = i.input_file ? (JSON.parse(await tc.os.fs.readText(tc.path(i.input_file))) as number[]) : (i.input ?? []);
      const r = await gpuCompute({ wgsl: i.wgsl, input, outputLength: i.output_length, workgroups: i.workgroups as [number, number?, number?] | undefined });
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const v of r.output) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      if (i.output_file) await tc.os.fs.writeFile(tc.path(i.output_file), JSON.stringify(Array.from(r.output)));
      return `GPU time ${r.ms.toFixed(1)} ms · ${r.output.length} values · min ${min} · max ${max} · sum ${sum}\nfirst values: ${JSON.stringify(Array.from(r.output.slice(0, 32)))}${i.output_file ? `\nsaved to ${tc.path(i.output_file)}` : ''}`;
    },
  }),
];
