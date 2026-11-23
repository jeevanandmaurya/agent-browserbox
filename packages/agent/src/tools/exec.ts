import { plainText } from '../host/ansi.js';
import { gpuCompute } from '../host/gpu.js';
import { quote, tempPath } from '../host/os.js';
import type { ToolContext } from './types.js';

/** What a sandbox run produced (the box reports it as a command's output and exit code). */
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  value?: string;
  error?: string;
  exitCode?: number;
}

/** Runs a command line in the agent's shell session, streaming its output to the tool's progress. */
async function runInBox(tc: ToolContext, line: string): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await tc.shell.run(line, { out: (t) => ((stdout += t), tc.progress(t)), err: (t) => ((stderr += t), tc.progress(t)), signal: tc.signal });
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

/** Writes source to a temporary file in the box, runs `command <file>`, and removes the file. */
export async function runSource(tc: ToolContext, command: string, source: string, ext: string): Promise<RunResult> {
  const file = tempPath(`code.${ext}`);
  await tc.os.fs.writeFile(file, source);
  try {
    return await runInBox(tc, `${command} ${quote(file)}`);
  } finally {
    await tc.os.fs.rm(file).catch(() => undefined);
  }
}
import { clip, obj, tool, type ToolDef } from './types.js';

/** Shell variables minus the shell's own bookkeeping. */

export function report(r: RunResult): string {
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
      'Run a command line in the BrowserBox shell (not bash, but POSIX-flavoured): pipes, redirects, &&, ||, ;, $VARS and globs work. Commands include ls, cat, grep, find, head, tail, wc, sort, uniq, mkdir, rm, cp, mv, tree, du, curl, js, python, wasm, gpu, ps, kill, open, sha256sum, gzip. Run `help` to list them all. Installed packages add more commands (see `pkg list`). The working directory persists between calls (cd works). There is no npm, apt or native compiler.',
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
      // Installing or removing a package changes the tools on offer (run_python): re-read the list.
      if (/\bpkg\s+(install|remove)\b/.test(i.command)) await tc.os.packages.refresh().catch(() => undefined);
      const text = clip(plainText(out).trimEnd() || '(no output)');
      if (code !== 0) throw new Error(`${text}\n[exit code ${code}]`);
      return text;
    },
  }),
  tool<{ code: string; network?: boolean }>({
    name: 'run_js',
    description:
      'Run JavaScript in an isolated sandbox (a Worker in an opaque-origin frame; no DOM). The code is the body of an async function: use await and return a value. Globals: `fs` (async: readText, readFile, writeFile, appendFile, readdir, exists, mkdir, rm, glob — paths relative to the working directory), `print(...)`, `console`. fetch only works when network is true, and then only for CORS-enabled URLs. A run is stopped after 2 minutes. Good for computation, data processing and generating files.',
    input_schema: obj({ code: { type: 'string' }, network: { type: 'boolean', description: 'allow outbound network (asks the user separately)' } }, ['code']),
    // Running code needs the code permission; network access is asked for on top, by the box.
    cap: () => 'exec',
    describe: (i) => `${i.network ? '[network] ' : ''}${i.code}`,
    async run(i, tc) {
      return report(await runSource(tc, `js${i.network ? ' --net' : ''}`, i.code, 'js'));
    },
  }),
  tool<{ path: string; args?: string[]; stdin?: string }>({
    name: 'run_wasm',
    description: 'Run a WebAssembly program (WASI preview1, stdio only) from a .wasm file in the filesystem. Returns its stdout, stderr and exit code.',
    input_schema: obj({ path: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, stdin: { type: 'string' } }, ['path']),
    cap: () => 'exec',
    describe: (i) => `Run ${i.path} ${(i.args ?? []).join(' ')}`,
    async run(i, tc) {
      const args = [tc.path(i.path), ...(i.args ?? [])].map(quote).join(' ');
      if (i.stdin === undefined) return report(await runInBox(tc, `wasm ${args}`));
      const input = tempPath('stdin.txt');
      await tc.os.fs.writeFile(input, i.stdin);
      try {
        return report(await runInBox(tc, `cat ${quote(input)} | wasm ${args}`));
      } finally {
        await tc.os.fs.rm(input).catch(() => undefined);
      }
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
  tool<{ code: string; packages?: string[] }>({
    name: 'run_python',
    description:
      'Run Python 3 (CPython compiled to WebAssembly via Pyodide) in an isolated sandbox. Files in the working directory are visible to the script and files it writes are saved back. Imports of bundled scientific packages (numpy, pandas, matplotlib, scipy, sympy…) load automatically; list pure-Python PyPI packages in `packages`. The interpreter persists between calls. No sockets or subprocesses.',
    input_schema: obj({ code: { type: 'string' }, packages: { type: 'array', items: { type: 'string' }, description: 'extra PyPI packages to install with micropip' } }, ['code']),
    cap: () => 'exec',
    describe: (i) => i.code,
    async run(i, tc) {
      if (i.packages?.length) {
        const pip = await runInBox(tc, `pip install ${i.packages.map(quote).join(' ')}`);
        if (!pip.ok) return report(pip);
      }
      return report(await runSource(tc, 'python', i.code, 'py'));
    },
  }),
];
