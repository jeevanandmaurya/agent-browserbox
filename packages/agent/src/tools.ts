import type { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import type { JsonSchema } from './types.js';

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

/** What a tool can reach while it runs. */
export interface ToolContext {
  box: BrowserBox;
  /** The agent's working folder; relative paths resolve against it. */
  cwd: string;
  signal: AbortSignal;
  /** Resolves a model-supplied path to an absolute path in the box. */
  path(p: string): string;
  setTodos(items: TodoItem[]): void;
}

export interface ToolDef<I = Record<string, unknown>> {
  name: string;
  description: string;
  input_schema: JsonSchema;
  /** One line describing this call, for the UI and for approval prompts. */
  describe(input: I): string;
  run(input: I, ctx: ToolContext): Promise<string>;
}

/** Keeps each tool's input type attached to its implementation. */
export function tool<I>(def: ToolDef<I>): ToolDef {
  return def as unknown as ToolDef;
}

const obj = (properties: JsonSchema['properties'], required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const MAX_RESULT = 30_000;

/** Keeps tool output within a sane context budget, preserving both ends. */
export function clip(text: string, max = MAX_RESULT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(text.length - (max - head))}`;
}

/** Quotes a value for the box's shell. */
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Normalises an absolute path ('.', '..', repeated slashes). */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** A glob ('**', '*', '?', '{a,b}') as a regular expression over '/'-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      }
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

function fence(r: { exitCode: number; stdout: string; stderr: string }): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.exitCode !== 0) parts.push(`[exit code ${r.exitCode}]`);
  return clip(parts.join('\n') || '(no output)');
}

/** The agent's tools. Every one works inside the box, through the SDK. */
export const BOX_TOOLS: ToolDef[] = [
  tool<{ path: string; offset?: number; limit?: number }>({
    name: 'read_file',
    description: 'Read a text file. Lines are numbered. For large files pass offset (first line, 1-based) and limit (number of lines).',
    input_schema: obj({ path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['path']),
    describe: (i) => `Read ${i.path}`,
    async run(i, ctx) {
      const lines = (await ctx.box.fs.readTextFile(ctx.path(i.path))).split('\n');
      const start = Math.max(1, i.offset ?? 1);
      const end = Math.min(lines.length, start - 1 + (i.limit ?? 2000));
      const body = lines.slice(start - 1, end).map((l, n) => `${start + n}\t${l}`).join('\n');
      const more = end < lines.length ? `\n… ${lines.length - end} more lines (read on with offset ${end + 1})` : '';
      return clip(body + more) || '(empty file)';
    },
  }),
  tool<{ path: string; content: string }>({
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent folders are created as needed.',
    input_schema: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    describe: (i) => `Write ${i.path}`,
    async run(i, ctx) {
      await ctx.box.fs.writeFile(ctx.path(i.path), i.content);
      return `Wrote ${ctx.path(i.path)} (${i.content.length} characters).`;
    },
  }),
  tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
    name: 'edit_file',
    description: 'Replace exact text in a file. old_string must match exactly once (include surrounding lines to make it unique), unless replace_all is true.',
    input_schema: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
    describe: (i) => `Edit ${i.path}`,
    async run(i, ctx) {
      const path = ctx.path(i.path);
      const text = await ctx.box.fs.readTextFile(path);
      if (!i.old_string) throw new Error('old_string is empty; use write_file to create a file');
      const count = text.split(i.old_string).length - 1;
      if (count === 0) throw new Error(`old_string was not found in ${path}`);
      if (count > 1 && !i.replace_all) throw new Error(`old_string occurs ${count} times in ${path}; add surrounding lines to make it unique, or pass replace_all`);
      await ctx.box.fs.writeFile(path, i.replace_all ? text.split(i.old_string).join(i.new_string) : text.replace(i.old_string, () => i.new_string));
      return `Edited ${path} (${i.replace_all ? count : 1} replacement${count > 1 && i.replace_all ? 's' : ''}).`;
    },
  }),
  tool<{ path?: string }>({
    name: 'list_dir',
    description: 'List a folder: names, with a trailing / for folders, and file sizes.',
    input_schema: obj({ path: { type: 'string' } }),
    describe: (i) => `List ${i.path ?? '.'}`,
    async run(i, ctx) {
      const entries = await ctx.box.fs.readdir(ctx.path(i.path ?? '.'));
      if (!entries.length) return '(empty folder)';
      return entries
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
        .map((e) => (e.kind === 'dir' ? `${e.name}/` : `${e.name}  ${e.size} B`))
        .join('\n');
    },
  }),
  tool<{ pattern: string; path?: string }>({
    name: 'glob',
    description: 'Find files by name pattern, e.g. "**/*.ts" or "src/*.{js,css}". Paths are relative to path (default: the working folder).',
    input_schema: obj({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
    describe: (i) => `Find ${i.pattern}`,
    async run(i, ctx) {
      const root = ctx.path(i.path ?? '.');
      const r = await ctx.box.exec(`find ${quote(root)} -type f`);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `find failed (${r.exitCode})`);
      const re = globToRegExp(i.pattern);
      const prefix = root === '/' ? '/' : `${root}/`;
      const hits = r.stdout.split('\n').filter(Boolean).map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)).filter((p) => re.test(p)).sort();
      if (!hits.length) return 'No files matched.';
      return hits.slice(0, 500).join('\n') + (hits.length > 500 ? `\n… and ${hits.length - 500} more` : '');
    },
  }),
  tool<{ pattern: string; path?: string; ignore_case?: boolean; fixed_string?: boolean }>({
    name: 'grep',
    description: 'Search file contents for a regular expression (or a fixed string), recursively. Returns path:line:text.',
    input_schema: obj({ pattern: { type: 'string' }, path: { type: 'string' }, ignore_case: { type: 'boolean' }, fixed_string: { type: 'boolean' } }, ['pattern']),
    describe: (i) => `Search for ${i.pattern}`,
    async run(i, ctx) {
      const flags = ['-rn', i.ignore_case ? '-i' : '', i.fixed_string ? '-F' : ''].filter(Boolean).join(' ');
      const r = await ctx.box.exec(`grep ${flags} ${quote(i.pattern)} ${quote(ctx.path(i.path ?? '.'))}`);
      if (r.exitCode === 1 && !r.stdout) return 'No matches.';
      if (r.exitCode > 1) throw new Error(r.stderr.trim() || `grep failed (${r.exitCode})`);
      return clip(r.stdout.trimEnd());
    },
  }),
  tool<{ command: string; cwd?: string; timeout_ms?: number }>({
    name: 'shell',
    description:
      "Run a command line in the box's shell (bbsh: Unix-style commands, pipes, &&, redirects; not bash). Run `help` to list commands. Returns stdout, stderr and the exit code.",
    input_schema: obj({ command: { type: 'string' }, cwd: { type: 'string' }, timeout_ms: { type: 'integer' } }, ['command']),
    describe: (i) => `Run: ${i.command}`,
    async run(i, ctx) {
      return fence(await ctx.box.exec(i.command, { cwd: ctx.path(i.cwd ?? '.'), timeoutMs: Math.min(i.timeout_ms ?? 120_000, 600_000) }));
    },
  }),
  tool<{ code: string; network?: boolean }>({
    name: 'run_js',
    description:
      'Run JavaScript in a sandboxed worker inside the box (top-level await works). Globals: print(...), console, fs (readText, writeFile, readdir, …, all async), args, env. No DOM, no npm imports. network: true asks for network access.',
    input_schema: obj({ code: { type: 'string' }, network: { type: 'boolean' } }, ['code']),
    describe: (i) => `Run JavaScript (${i.code.split('\n').length} lines)`,
    async run(i, ctx) {
      const file = `/tmp/agent-${Math.random().toString(36).slice(2)}.js`;
      await ctx.box.fs.writeFile(file, i.code);
      try {
        return fence(await ctx.box.exec(`js${i.network ? ' --net' : ''} ${quote(file)}`, { cwd: ctx.cwd, timeoutMs: 300_000 }));
      } finally {
        await ctx.box.fs.rm(file).catch(() => undefined);
      }
    },
  }),
  tool<{ items: TodoItem[] }>({
    name: 'todo_write',
    description: 'Keep a todo list for multi-step work. Send the whole list each time, with each item pending, in_progress or done.',
    input_schema: obj(
      {
        items: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'], additionalProperties: false },
        },
      },
      ['items'],
    ),
    describe: (i) => `Update todos (${i.items.length})`,
    async run(i, ctx) {
      ctx.setTodos(i.items);
      return `Todo list updated: ${i.items.filter((t) => t.status === 'done').length}/${i.items.length} done.`;
    },
  }),
];
