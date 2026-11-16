import { flags, type Command, type CommandContext } from '../shell';
import { C } from '../ansi';

/** Reads the named files, or stdin when none are given. */
async function input(ctx: CommandContext, files: string[]): Promise<string> {
  if (!files.length) return ctx.stdin;
  let text = '';
  for (const f of files) text += await ctx.os.fs.readText(ctx.path(f));
  return text;
}

const lines = (text: string) => {
  const l = text.split('\n');
  if (l.at(-1) === '') l.pop();
  return l;
};

function count(args: string[], fallback: number): { n: number; rest: string[] } {
  const i = args.indexOf('-n');
  if (i >= 0) return { n: Number(args[i + 1]) || fallback, rest: args.filter((_, j) => j !== i && j !== i + 1) };
  const short = args.find((a) => /^-\d+$/.test(a));
  return { n: short ? Number(short.slice(1)) : fallback, rest: args.filter((a) => a !== short) };
}

async function pipeThrough(data: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const textCommands: Command[] = [
  {
    name: 'echo',
    summary: 'print arguments',
    async run({ args, out }) {
      const n = args[0] === '-n';
      out((n ? args.slice(1) : args).join(' ') + (n ? '' : '\n'));
    },
  },
  {
    name: 'grep',
    summary: 'search text with a regular expression',
    usage: 'grep [-i] [-n] [-v] [-r] [-F] pattern [path…]',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      const pattern = rest.shift();
      if (pattern === undefined) throw new Error('usage: grep [-invrF] pattern [path…]');
      const re = new RegExp(opts.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, opts.has('i') ? 'i' : '');
      let hits = 0;
      const scan = (text: string, label: string | null) => {
        lines(text).forEach((line, i) => {
          if (re.test(line) === opts.has('v')) return;
          hits++;
          const shown = opts.has('v') ? line : line.replace(re, (m) => `${C.red}${m}${C.reset}`);
          ctx.out(`${label ? `${C.magenta}${label}${C.reset}:` : ''}${opts.has('n') ? `${C.green}${i + 1}${C.reset}:` : ''}${shown}\n`);
        });
      };
      if (!rest.length) scan(ctx.stdin, null);
      for (const target of rest) {
        const p = ctx.path(target);
        const st = await ctx.os.fs.stat(p);
        if (!st) throw new Error(`${target}: no such file or directory`);
        if (st.kind === 'file') scan(await ctx.os.fs.readText(p), rest.length > 1 ? target : null);
        else if (opts.has('r')) {
          for await (const s of ctx.os.fs.walk(p, { signal: ctx.signal })) {
            if (s.kind === 'file' && s.size < 2_000_000) scan(await ctx.os.fs.readText(s.path).catch(() => ''), s.path);
          }
        } else throw new Error(`${target}: is a directory (use -r)`);
      }
      return hits ? 0 : 1;
    },
  },
  {
    name: 'head',
    summary: 'first lines of input',
    usage: 'head [-n N] [file…]',
    async run(ctx) {
      const { n, rest } = count(ctx.args, 10);
      const l = lines(await input(ctx, rest)).slice(0, n);
      if (l.length) ctx.out(l.join('\n') + '\n');
    },
  },
  {
    name: 'tail',
    summary: 'last lines of input',
    usage: 'tail [-n N] [file…]',
    async run(ctx) {
      const { n, rest } = count(ctx.args, 10);
      const l = lines(await input(ctx, rest)).slice(-n);
      if (l.length) ctx.out(l.join('\n') + '\n');
    },
  },
  {
    name: 'wc',
    summary: 'count lines, words and bytes (Rust/WASM)',
    usage: 'wc [-l] [file…]',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      const data = new TextEncoder().encode(await input(ctx, rest));
      const r = ctx.os.kcore.wc(data);
      ctx.out(opts.has('l') ? `${r.lines}\n` : `${String(r.lines).padStart(7)} ${String(r.words).padStart(7)} ${String(r.bytes).padStart(7)}\n`);
    },
  },
  {
    name: 'sort',
    summary: 'sort lines',
    usage: 'sort [-r] [-n] [-u] [file…]',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      let l = lines(await input(ctx, rest));
      l.sort(opts.has('n') ? (a, b) => parseFloat(a) - parseFloat(b) : undefined);
      if (opts.has('r')) l.reverse();
      if (opts.has('u')) l = [...new Set(l)];
      if (l.length) ctx.out(l.join('\n') + '\n');
    },
  },
  {
    name: 'uniq',
    summary: 'drop adjacent duplicate lines',
    usage: 'uniq [-c] [file…]',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      const groups: Array<[string, number]> = [];
      for (const line of lines(await input(ctx, rest))) {
        const last = groups.at(-1);
        if (last && last[0] === line) last[1]++;
        else groups.push([line, 1]);
      }
      for (const [line, n] of groups) ctx.out(opts.has('c') ? `${String(n).padStart(7)} ${line}\n` : `${line}\n`);
    },
  },
  {
    name: 'tee',
    summary: 'copy stdin to files and stdout',
    usage: 'tee [-a] file…',
    async run(ctx) {
      const { opts, rest } = flags(ctx.args);
      for (const f of rest) await (opts.has('a') ? ctx.os.fs.appendFile(ctx.path(f), ctx.stdin) : ctx.os.fs.writeFile(ctx.path(f), ctx.stdin));
      ctx.out(ctx.stdin);
    },
  },
  {
    name: 'sha256sum',
    summary: 'SHA-256 digest (Web Crypto)',
    usage: 'sha256sum [file…]',
    async run(ctx) {
      const digest = async (data: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (!ctx.args.length) return void ctx.out(`${await digest(new TextEncoder().encode(ctx.stdin))}  -\n`);
      for (const f of ctx.args) ctx.out(`${await digest(await ctx.os.fs.readFile(ctx.path(f)))}  ${f}\n`);
    },
  },
  {
    name: 'hash',
    summary: 'fast FNV-1a content hash (Rust/WASM)',
    usage: 'hash file…',
    async run(ctx) {
      for (const f of ctx.args) ctx.out(`${ctx.os.kcore.hash(await ctx.os.fs.readFile(ctx.path(f)))}  ${f}\n`);
    },
  },
  {
    name: 'gzip',
    summary: 'compress a file to file.gz (Compression Streams)',
    usage: 'gzip file…',
    async run(ctx) {
      if (!('CompressionStream' in globalThis)) throw new Error('Compression Streams are not supported in this browser');
      for (const f of ctx.args) {
        const p = ctx.path(f);
        await ctx.os.fs.writeFile(p + '.gz', await pipeThrough(await ctx.os.fs.readFile(p), new CompressionStream('gzip')));
        await ctx.os.fs.rm(p);
      }
    },
  },
  {
    name: 'gunzip',
    summary: 'decompress file.gz',
    usage: 'gunzip file.gz…',
    async run(ctx) {
      if (!('DecompressionStream' in globalThis)) throw new Error('Compression Streams are not supported in this browser');
      for (const f of ctx.args) {
        const p = ctx.path(f);
        if (!p.endsWith('.gz')) throw new Error(`${f}: unknown suffix`);
        await ctx.os.fs.writeFile(p.slice(0, -3), await pipeThrough(await ctx.os.fs.readFile(p), new DecompressionStream('gzip')));
        await ctx.os.fs.rm(p);
      }
    },
  },
];
