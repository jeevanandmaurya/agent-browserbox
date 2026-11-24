import { HOME } from '../kernel/paths';
import { runJs, runWasm } from '../sandbox/sandbox';
import { finish, userEnv } from './commands/exec';
import type { Command, CommandContext } from './shell';

/**
 * Running programs that are not built in: commands from installed packages
 * (wasm, js, script), and your own scripts in ~/.local/bin.
 */
export type ProgramKind = 'wasm' | 'js' | 'script';

/** Where your own commands live: an executable here is a command by its name. */
export const LOCAL_BIN = `${HOME}/.local/bin`;

/** Runs a program file: WASI WebAssembly, a BrowserBox JavaScript program, or a shell script. */
export async function runProgram(ctx: CommandContext, kind: ProgramKind, bytes: Uint8Array, name: string, args: string[], assets?: Record<string, Uint8Array>): Promise<number> {
  const env = { ...userEnv(ctx.shell.env), PWD: ctx.shell.cwd };
  const io = { signal: ctx.signal, onStdout: ctx.out, onStderr: ctx.err, ppid: ctx.shell.ppid, cwd: ctx.shell.cwd, env };
  if (kind === 'wasm') return finish(ctx, await runWasm(ctx.os, bytes, { ...io, name, args, stdin: ctx.stdin }));
  const text = new TextDecoder().decode(bytes);
  // A program with assets (a video or OCR engine) may work on big files for a while.
  if (kind === 'js') return finish(ctx, await runJs(ctx.os, text, { ...io, args, stdin: ctx.stdin, assets, timeoutMs: assets && Object.keys(assets).length ? 600_000 : 120_000 }));
  // A shell script runs line by line in this shell (like `source`): $1… are not set, $ARGS holds the arguments.
  const before = ctx.shell.env.ARGS;
  ctx.shell.env.ARGS = args.join(' ');
  try {
    return await ctx.shell.run(text, { out: ctx.out, err: ctx.err, signal: ctx.signal, stdin: ctx.stdin });
  } finally {
    if (before === undefined) delete ctx.shell.env.ARGS;
    else ctx.shell.env.ARGS = before;
  }
}

const kindOfFile = (path: string, bytes: Uint8Array): ProgramKind | null => {
  if (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) return 'wasm';
  if (/\.(m?js)$/.test(path)) return 'js';
  if (/\.sh$/.test(path) || new TextDecoder().decode(bytes.subarray(0, 32)).startsWith('#!')) return 'script';
  return null;
};

/** A command from an installed package. */
export function packageCommand(name: string, ext: { pkg: { id: string; kind: ProgramKind; summary: string }; entry: { args?: string[] }; file(): Promise<Uint8Array>; assets?(): Promise<Record<string, Uint8Array>> }): Command {
  return {
    name,
    summary: `${ext.pkg.summary || name} (${ext.pkg.id} package)`,
    run: async (ctx) => runProgram(ctx, ext.pkg.kind, await ext.file(), name, [...(ext.entry.args ?? []), ...ctx.args], await ext.assets?.()),
  };
}

/** A command from ~/.local/bin: `name`, or `name.wasm`, `name.js`, `name.sh`. */
export async function localCommand(os: CommandContext['os'], name: string): Promise<Command | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) return null;
  for (const file of [name, `${name}.wasm`, `${name}.js`, `${name}.sh`]) {
    const path = `${LOCAL_BIN}/${file}`;
    const st = await os.fs.stat(path).catch(() => null);
    if (st?.kind !== 'file') continue;
    return {
      name,
      summary: `your command (${path})`,
      run: async (ctx) => {
        const bytes = await ctx.os.fs.readFile(path);
        const kind = kindOfFile(path, bytes);
        if (!kind) throw new Error(`${path}: not a program (a .wasm, .js or .sh file, or a script starting with #!)`);
        return runProgram(ctx, kind, bytes, name, ctx.args);
      },
    };
  }
  return null;
}

/** Names of the commands in ~/.local/bin, for completion. */
export async function localCommandNames(os: CommandContext['os']): Promise<string[]> {
  return (await os.fs.readdir(LOCAL_BIN).catch(() => [])).filter((e) => e.kind === 'file').map((e) => e.name.replace(/\.(wasm|m?js|sh)$/, ''));
}
