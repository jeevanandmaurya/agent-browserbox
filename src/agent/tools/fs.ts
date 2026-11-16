import { AGENT_HOME } from '@/kernel/kernel';
import { isInside } from '@/kernel/vfs/path';
import { clip, obj, tool, type ToolContext, type ToolDef } from './types';

/** Writes inside the agent's workspace and /tmp are free; anywhere else needs a grant. */
const writeCap = (paths: string[], tc: ToolContext) => (paths.every((p) => isInside(AGENT_HOME, tc.path(p)) || isInside('/tmp', tc.path(p))) ? null : 'fs.write');

function looksBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 4096);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

export const fsTools: ToolDef[] = [
  tool<{ path: string; offset?: number; limit?: number }>({
    name: 'read_file',
    description: 'Read a text file from the virtual filesystem. Returns lines prefixed with line numbers. Use offset/limit (in lines) for large files.',
    input_schema: obj({ path: { type: 'string' }, offset: { type: 'integer', description: '1-based first line' }, limit: { type: 'integer', description: 'max lines (default 2000)' } }, ['path']),
    cap: () => null,
    describe: (i) => `Read ${i.path}`,
    async run(i, tc) {
      const data = await tc.os.fs.readFile(tc.path(i.path));
      if (looksBinary(data)) return `(binary file, ${data.length} bytes)`;
      const lines = new TextDecoder().decode(data).split('\n');
      const start = Math.max(1, i.offset ?? 1);
      const slice = lines.slice(start - 1, start - 1 + (i.limit ?? 2000));
      const body = slice.map((l, n) => `${String(start + n).padStart(5)}\t${l}`).join('\n');
      const more = start - 1 + slice.length < lines.length ? `\n(${lines.length} lines total; showing ${start}–${start + slice.length - 1})` : '';
      return clip(body + more, 60_000) || '(empty file)';
    },
  }),
  tool<{ path: string; content: string }>({
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
    input_schema: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
    cap: (i, tc) => writeCap([i.path], tc),
    describe: (i) => `Write ${i.path} (${i.content.length} chars)`,
    async run(i, tc) {
      await tc.os.fs.writeFile(tc.path(i.path), i.content);
      return `Wrote ${i.content.length} characters to ${tc.path(i.path)}`;
    },
  }),
  tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>({
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true. Prefer this over rewriting whole files.',
    input_schema: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
    cap: (i, tc) => writeCap([i.path], tc),
    describe: (i) => `Edit ${i.path}`,
    async run(i, tc) {
      const p = tc.path(i.path);
      const text = await tc.os.fs.readText(p);
      if (!i.old_string) throw new Error('old_string must not be empty');
      const count = text.split(i.old_string).length - 1;
      if (count === 0) throw new Error('old_string was not found in the file. Read the file again and match it exactly, including whitespace.');
      if (count > 1 && !i.replace_all) throw new Error(`old_string occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`);
      await tc.os.fs.writeFile(p, i.replace_all ? text.split(i.old_string).join(i.new_string) : text.replace(i.old_string, () => i.new_string));
      return `Edited ${p} (${i.replace_all ? count : 1} replacement${count > 1 && i.replace_all ? 's' : ''})`;
    },
  }),
  tool<{ path?: string }>({
    name: 'list_dir',
    description: 'List a directory: name, kind, size and modification time of each entry.',
    input_schema: obj({ path: { type: 'string', description: 'defaults to the working directory' } }),
    cap: () => null,
    describe: (i) => `List ${i.path ?? '.'}`,
    async run(i, tc) {
      const list = await tc.os.fs.readdir(tc.path(i.path ?? '.'));
      if (!list.length) return '(empty directory)';
      return clip(list.map((s) => `${s.kind === 'dir' ? 'dir ' : 'file'}  ${String(s.size).padStart(9)}  ${s.mtime ? new Date(s.mtime).toISOString().slice(0, 16) : '                '}  ${s.name}${s.kind === 'dir' ? '/' : ''}`).join('\n'));
    },
  }),
  tool<{ pattern: string; path?: string }>({
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/*.{js,css}". Returns matching paths.',
    input_schema: obj({ pattern: { type: 'string' }, path: { type: 'string', description: 'base directory (default: working directory)' } }, ['pattern']),
    cap: () => null,
    describe: (i) => `Glob ${i.pattern}`,
    async run(i, tc) {
      const hits = await tc.os.fs.glob(i.pattern, tc.path(i.path ?? '.'), 500);
      return hits.length ? hits.join('\n') : 'No files matched.';
    },
  }),
  tool<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean; literal?: boolean }>({
    name: 'grep',
    description: 'Search file contents under a path. pattern is a JavaScript regular expression unless literal is true (literal search runs in the Rust/WASM kernel core and is faster). Returns path:line:text.',
    input_schema: obj(
      { pattern: { type: 'string' }, path: { type: 'string', description: 'file or directory (default: working directory)' }, glob: { type: 'string', description: 'only search files whose name matches, e.g. "*.md"' }, ignore_case: { type: 'boolean' }, literal: { type: 'boolean' } },
      ['pattern'],
    ),
    cap: () => null,
    describe: (i) => `Grep "${i.pattern}" in ${i.path ?? '.'}`,
    async run(i, tc) {
      const root = tc.path(i.path ?? '.');
      const st = await tc.os.fs.stat(root);
      if (!st) throw new Error(`no such file or directory: ${root}`);
      const nameRe = i.glob ? new RegExp('^' + i.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
      const re = i.literal ? null : new RegExp(i.pattern, i.ignore_case ? 'i' : '');
      const out: string[] = [];
      let files = 0;
      const scan = async (path: string) => {
        const data = await tc.os.fs.readFile(path).catch(() => null);
        if (!data || looksBinary(data)) return;
        files++;
        const text = new TextDecoder().decode(data);
        const lines = text.split('\n');
        if (re) {
          lines.forEach((l, n) => {
            if (out.length < 300 && re.test(l)) out.push(`${path}:${n + 1}:${l.slice(0, 300)}`);
          });
        } else {
          for (const m of tc.os.kcore.searchLines(data, i.pattern, i.ignore_case, 300).matches) if (out.length < 300) out.push(`${path}:${m.line}:${(lines[m.line - 1] ?? '').slice(0, 300)}`);
        }
      };
      if (st.kind === 'file') await scan(root);
      else {
        for await (const s of tc.os.fs.walk(root, { signal: tc.signal })) {
          if (out.length >= 300 || files > 5000) break;
          if (s.kind === 'file' && s.size < 2_000_000 && (!nameRe || nameRe.test(s.name))) await scan(s.path);
        }
      }
      return out.length ? clip(out.join('\n')) + (out.length >= 300 ? '\n(showing the first 300 matches)' : '') : `No matches in ${files} file${files === 1 ? '' : 's'}.`;
    },
  }),
  tool<{ path: string }>({
    name: 'delete_path',
    description: 'Delete a file or a directory (recursively).',
    input_schema: obj({ path: { type: 'string' } }, ['path']),
    cap: (i, tc) => writeCap([i.path], tc),
    describe: (i) => `Delete ${i.path}`,
    async run(i, tc) {
      await tc.os.fs.rm(tc.path(i.path), { recursive: true });
      return `Deleted ${tc.path(i.path)}`;
    },
  }),
  tool<{ from: string; to: string; copy?: boolean }>({
    name: 'move_path',
    description: 'Move or rename a file or directory. Set copy to true to copy instead.',
    input_schema: obj({ from: { type: 'string' }, to: { type: 'string' }, copy: { type: 'boolean' } }, ['from', 'to']),
    cap: (i, tc) => writeCap(i.copy ? [i.to] : [i.from, i.to], tc),
    describe: (i) => `${i.copy ? 'Copy' : 'Move'} ${i.from} → ${i.to}`,
    async run(i, tc) {
      await (i.copy ? tc.os.fs.cp(tc.path(i.from), tc.path(i.to)) : tc.os.fs.mv(tc.path(i.from), tc.path(i.to)));
      return `${i.copy ? 'Copied' : 'Moved'} ${tc.path(i.from)} → ${tc.path(i.to)}`;
    },
  }),
];
