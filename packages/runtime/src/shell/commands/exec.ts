import { gpuCompute } from '../../sandbox/gpu';
import { runJs, runWasm, type RunResult } from '../../sandbox/sandbox';
import { flags, requireNetwork, type Command, type CommandContext } from '../shell';

/** A shell's environment as a program sees it (without `?`, the last exit code). */
export const userEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== '?'));

function finish(ctx: CommandContext, r: RunResult): number {
  if (r.value !== undefined && r.value !== 'undefined') ctx.out(r.value + '\n');
  if (r.error) ctx.err(r.error + '\n');
  return r.ok ? 0 : (r.exitCode ?? 1);
}

/** `-e code`, a script file, or stdin. */
async function source(ctx: CommandContext, rest: string[], opts: Set<string>): Promise<{ code: string; args: string[] }> {
  if (opts.has('e') || opts.has('c')) return { code: rest[0] ?? '', args: rest.slice(1) };
  if (rest[0]) return { code: await ctx.os.fs.readText(ctx.path(rest[0])), args: rest.slice(1) };
  if (ctx.stdin) return { code: ctx.stdin, args: [] };
  throw new Error('nothing to run: pass a file, -e "code", or pipe code in');
}

export const execCommands: Command[] = [
  {
    name: 'js',
    summary: 'run JavaScript in an isolated sandbox',
    usage: 'js [--net] file.js [args…]  |  js -e "code"   (globals: fs, print, console, args)',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      const { code, args } = await source(ctx, rest, opts);
      if (opts.has('net')) await requireNetwork(ctx, 'js', 'network access for a JavaScript program');
      return finish(ctx, await runJs(ctx.os, code, { cwd: ctx.shell.cwd, env: userEnv(ctx.shell.env), args, network: opts.has('net'), signal: ctx.signal, onStdout: ctx.out, onStderr: ctx.err, ppid: ctx.shell.ppid, timeoutMs: 120000 }));
    },
  },
  {
    name: 'wasm',
    summary: 'run a WASI WebAssembly program',
    usage: 'wasm program.wasm [args…]',
    async run(ctx) {
      const file = ctx.args[0];
      if (!file) throw new Error('usage: wasm program.wasm [args…]');
      const bytes = await ctx.os.fs.readFile(ctx.path(file));
      return finish(ctx, await runWasm(ctx.os, bytes, { name: file, args: ctx.args.slice(1), stdin: ctx.stdin, signal: ctx.signal, onStdout: ctx.out, onStderr: ctx.err, ppid: ctx.shell.ppid }));
    },
  },
  {
    name: 'gpu',
    summary: 'run a WGSL compute shader on WebGPU',
    usage: 'gpu shader.wgsl <outputLength> [input.json]',
    async run(ctx) {
      const [file, n, inputFile] = ctx.args;
      if (!file || !n) throw new Error('usage: gpu shader.wgsl <outputLength> [input.json]');
      const input = inputFile ? (JSON.parse(await ctx.os.fs.readText(ctx.path(inputFile))) as number[]) : ctx.stdin.trim() ? (JSON.parse(ctx.stdin) as number[]) : [];
      const r = await gpuCompute({ wgsl: await ctx.os.fs.readText(ctx.path(file)), input, outputLength: Number(n) });
      ctx.out(JSON.stringify(Array.from(r.output.slice(0, 64))) + (r.output.length > 64 ? ` … (${r.output.length} values)` : '') + `\n${r.ms.toFixed(1)} ms\n`);
    },
  },
  {
    name: 'curl',
    summary: 'fetch a URL (subject to browser CORS rules)',
    usage: 'curl [-i] [-X METHOD] [-H "k: v"] [-d body] [-o file] url',
    async run(ctx) {
      const a = [...ctx.args];
      const init: RequestInit & { headers: Record<string, string> } = { headers: {}, signal: ctx.signal };
      let url = '';
      let outFile: string | undefined;
      let showHeaders = false;
      while (a.length) {
        const t = a.shift()!;
        if (t === '-X') init.method = a.shift();
        else if (t === '-H') {
          const hd = a.shift() ?? '';
          const i = hd.indexOf(':');
          if (i > 0) init.headers[hd.slice(0, i).trim()] = hd.slice(i + 1).trim();
        } else if (t === '-d' || t === '--data') {
          init.body = a.shift();
          init.method ??= 'POST';
        } else if (t === '-o') outFile = a.shift();
        else if (t === '-i') showHeaders = true;
        else if (t === '-s' || t === '-L') continue;
        else url = t;
      }
      if (!url) throw new Error('usage: curl [options] url');
      if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
      await requireNetwork(ctx, 'curl', url);
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        throw new Error(`could not fetch ${url} — the server is unreachable or does not allow cross-origin requests (CORS)`);
      }
      if (showHeaders) {
        ctx.out(`HTTP ${res.status} ${res.statusText}\n`);
        res.headers.forEach((v, k) => ctx.out(`${k}: ${v}\n`));
        ctx.out('\n');
      }
      if (outFile) await ctx.os.fs.writeFile(ctx.path(outFile), new Uint8Array(await res.arrayBuffer()));
      else ctx.out(await res.text());
      return res.ok ? 0 : 22;
    },
  },
];
