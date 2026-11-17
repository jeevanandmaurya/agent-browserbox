import type { KernelCore as Kernel } from '@/kernel/kernel';
import { AGENT_HOME, HOME } from '@/kernel/paths';
import { resolve } from '@/kernel/vfs/path';
import { parse, ShellSyntaxError, splitJobs, type Stage, type Word } from './parse';

/** An interactive terminal, when the shell has one. */
export interface Tty {
  /** Reads a line from the user; null on EOF / cancel. */
  readLine(prompt: string): Promise<string | null>;
  clear(): void;
}

export interface CommandContext {
  os: Kernel;
  shell: Shell;
  /** Arguments after the command name. */
  args: string[];
  stdin: string;
  out(text: string): void;
  err(text: string): void;
  signal: AbortSignal;
  /** Present only when attached to a terminal and this is the last stage of a pipeline. */
  tty?: Tty;
  /** Resolve a user-supplied path against the shell's cwd. */
  path(p: string): string;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  run(ctx: CommandContext): Promise<number | void>;
}

export interface RunIo {
  out(text: string): void;
  err(text: string): void;
  signal?: AbortSignal;
  stdin?: string;
}

/** Splits `-la` style flags from positional arguments. */
export function flags(args: string[]): { opts: Set<string>; rest: string[] } {
  const opts = new Set<string>();
  const rest: string[] = [];
  let done = false;
  for (const a of args) {
    if (!done && a === '--') done = true;
    else if (!done && a.startsWith('--') && a.length > 2) opts.add(a.slice(2));
    else if (!done && a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) for (const c of a.slice(1)) opts.add(c);
    else rest.push(a);
  }
  return { opts, rest };
}

/**
 * The BrowserBox shell: a small POSIX-flavoured interpreter over the VFS.
 * Used by the Terminal app and by the agent's `shell` tool, so both see the
 * same commands and the same sandbox.
 */
export class Shell {
  cwd: string;
  env: Record<string, string>;
  history: string[] = [];
  readonly commands = new Map<string, Command>();
  tty?: Tty;
  /** Pid that child processes (sandboxes, agents) are attributed to. */
  ppid = 0;

  constructor(
    readonly os: Kernel,
    opts: { cwd?: string; tty?: Tty; ppid?: number } = {},
  ) {
    this.cwd = opts.cwd ?? HOME;
    this.tty = opts.tty;
    this.ppid = opts.ppid ?? 0;
    // Variables from Settings → Environment are present in every shell.
    this.env = { ...os.settings.get<Record<string, string>>('env.vars', {}), HOME, USER: 'user', SHELL: '/bin/bbsh', AGENT_HOME, PATH: '/bin', '?': '0' };
  }

  register(...cmds: Command[]): this {
    for (const c of cmds) this.commands.set(c.name, c);
    return this;
  }

  async #expand(words: Word[]): Promise<string[]> {
    const out: string[] = [];
    for (const w of words) {
      if (w.bare && /[*?{]/.test(w.text)) {
        const hits = await this.os.fs.glob(w.text, this.cwd).catch(() => []);
        if (hits.length) {
          const prefix = this.cwd === '/' ? '/' : this.cwd + '/';
          out.push(...hits.map((p) => (!w.text.startsWith('/') && p.startsWith(prefix) ? p.slice(prefix.length) : p)));
          continue;
        }
      }
      out.push(w.text);
    }
    return out;
  }

  /** Runs a command line. Never throws: errors go to `io.err` and the exit code. */
  async run(line: string, io: RunIo): Promise<number> {
    let code = 0;
    const signal = io.signal ?? new AbortController().signal;
    try {
      let skip = false;
      for (const part of splitJobs(line)) {
        if (!skip) {
          if (!part.src.trim()) throw new ShellSyntaxError('syntax error: empty command');
          for (const job of parse(part.src, this.env)) code = await this.#pipeline(job.stages, io, signal);
          this.env['?'] = String(code);
        }
        if (signal.aborted) break;
        skip = part.next === '&&' ? code !== 0 : part.next === '||' ? code === 0 : false;
      }
    } catch (err) {
      io.err(`${err instanceof ShellSyntaxError ? 'bbsh' : 'bbsh: error'}: ${(err as Error).message}\n`);
      code = 2;
    }
    this.env['?'] = String(code);
    return code;
  }

  async #pipeline(stages: Stage[], io: RunIo, signal: AbortSignal): Promise<number> {
    let stdin = io.stdin ?? '';
    let code = 0;
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const last = i === stages.length - 1;
      const argv = await this.#expand(stage.argv);
      const name = argv[0]!;
      const cmd = this.commands.get(name);
      if (!cmd) {
        io.err(`bbsh: ${name}: command not found\n`);
        return 127;
      }
      if (stage.stdin) stdin = await this.os.fs.readText(resolve(this.cwd, stage.stdin.text));
      let buffer = '';
      const capture = !last || stage.stdout !== undefined;
      try {
        const result = await cmd.run({
          os: this.os,
          shell: this,
          args: argv.slice(1),
          stdin,
          out: capture ? (t) => (buffer += t) : io.out,
          err: io.err,
          signal,
          tty: last && !stage.stdout ? this.tty : undefined,
          path: (p) => resolve(this.cwd, p),
        });
        code = result ?? 0;
      } catch (err) {
        if (signal.aborted) {
          io.err('^C\n');
          return 130;
        }
        io.err(`${name}: ${(err as Error).message}\n`);
        code = 1;
      }
      if (stage.stdout) {
        const target = resolve(this.cwd, stage.stdout.target.text);
        try {
          if (stage.stdout.append) await this.os.fs.appendFile(target, buffer);
          else await this.os.fs.writeFile(target, buffer);
        } catch (err) {
          io.err(`bbsh: ${(err as Error).message}\n`);
          return 1;
        }
        buffer = '';
      }
      stdin = buffer;
      if (signal.aborted) return 130;
    }
    return code;
  }

  /** Tab completion for the word under the cursor. */
  async complete(line: string): Promise<{ start: number; options: string[] }> {
    const start = Math.max(line.lastIndexOf(' '), line.lastIndexOf('|'), line.lastIndexOf(';')) + 1;
    const word = line.slice(start);
    const first = !/\S/.test(line.slice(0, start).split(/[|;&]/).pop() ?? '');
    if (first && !word.includes('/')) return { start, options: [...this.commands.keys()].filter((c) => c.startsWith(word)).sort() };
    const slash = word.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.slice(0, slash + 1) : '';
    const base = word.slice(slash + 1);
    const dir = resolve(this.cwd, dirPart.replace(/^~/, this.env.HOME ?? '~') || '.');
    const entries = await this.os.fs.readdir(dir).catch(() => []);
    return { start, options: entries.filter((e) => e.name.startsWith(base)).map((e) => dirPart + e.name + (e.kind === 'dir' ? '/' : ' ')) };
  }
}
