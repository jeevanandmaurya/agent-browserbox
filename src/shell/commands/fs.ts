import { basename, join } from '@/kernel/vfs/path';
import type { Stat } from '@/kernel/vfs/types';
import { fmtBytes } from '@/kernel/format';
import { flags, type Command } from '../shell';
import { C } from '../ansi';

const date = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '                ');
const paint = (s: Stat) => (s.kind === 'dir' ? `${C.blue}${s.name}/${C.reset}` : s.name);

export const fsCommands: Command[] = [
  {
    name: 'pwd',
    summary: 'print the working directory',
    async run({ shell, out }) {
      out(shell.cwd + '\n');
    },
  },
  {
    name: 'cd',
    summary: 'change directory',
    usage: 'cd [dir]',
    async run({ args, shell, os, path }) {
      const target = path(args[0] ?? shell.env.HOME ?? '/');
      const st = await os.fs.stat(target);
      if (!st) throw new Error(`no such directory: ${args[0]}`);
      if (st.kind !== 'dir') throw new Error(`not a directory: ${args[0]}`);
      shell.cwd = target;
    },
  },
  {
    name: 'ls',
    summary: 'list directory contents',
    usage: 'ls [-la] [path…]',
    async run({ args, os, out, path }) {
      const { opts, rest } = flags(args);
      const targets = rest.length ? rest : ['.'];
      let code = 0;
      for (const t of targets) {
        const p = path(t);
        const st = await os.fs.stat(p);
        if (!st) {
          out(`ls: ${t}: no such file or directory\n`);
          code = 1;
          continue;
        }
        let list = st.kind === 'dir' ? await os.fs.readdir(p) : [st];
        if (!opts.has('a')) list = list.filter((s) => !s.name.startsWith('.'));
        if (targets.length > 1) out(`${t}:\n`);
        if (opts.has('l')) for (const s of list) out(`${s.kind === 'dir' ? 'd' : '-'}  ${fmtBytes(s.size).padStart(8)}  ${date(s.mtime)}  ${paint(s)}\n`);
        else if (list.length) out(list.map(paint).join('  ') + '\n');
      }
      return code;
    },
  },
  {
    name: 'tree',
    summary: 'show a directory tree',
    usage: 'tree [path] [-L depth]',
    async run({ args, os, out, path, signal }) {
      const li = args.indexOf('-L');
      const depth = li >= 0 ? Number(args[li + 1]) || 3 : 4;
      const root = path(args.filter((a, i) => a !== '-L' && i !== li + 1)[0] ?? '.');
      let count = 0;
      const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
        if (level >= depth) return;
        const list = await os.fs.readdir(dir);
        for (const [i, s] of list.entries()) {
          signal.throwIfAborted();
          if (++count > 2000) return;
          const last = i === list.length - 1;
          out(`${prefix}${last ? '└── ' : '├── '}${paint(s)}\n`);
          if (s.kind === 'dir' && s.path !== '/proc') await walk(s.path, prefix + (last ? '    ' : '│   '), level + 1);
        }
      };
      out(`${root}\n`);
      await walk(root, '', 0);
      if (count > 2000) out('… (truncated)\n');
    },
  },
  {
    name: 'cat',
    summary: 'print files',
    usage: 'cat [file…]',
    async run({ args, os, out, stdin, path }) {
      if (!args.length) return void out(stdin);
      for (const a of args) out(await os.fs.readText(path(a)));
    },
  },
  {
    name: 'mkdir',
    summary: 'create directories (parents included)',
    usage: 'mkdir dir…',
    async run({ args, os, path }) {
      const { rest } = flags(args);
      if (!rest.length) throw new Error('missing operand');
      for (const a of rest) await os.fs.mkdir(path(a));
    },
  },
  {
    name: 'touch',
    summary: 'create empty files',
    usage: 'touch file…',
    async run({ args, os, path }) {
      for (const a of args) if (!(await os.fs.exists(path(a)))) await os.fs.writeFile(path(a), '');
    },
  },
  {
    name: 'rm',
    summary: 'remove files or directories',
    usage: 'rm [-rf] path…',
    async run({ args, os, err, path }) {
      const { opts, rest } = flags(args);
      if (!rest.length) throw new Error('missing operand');
      let code = 0;
      for (const a of rest) {
        const p = path(a);
        const st = await os.fs.stat(p);
        if (!st) {
          if (!opts.has('f')) {
            err(`rm: ${a}: no such file or directory\n`);
            code = 1;
          }
          continue;
        }
        if (st.kind === 'dir' && !opts.has('r') && !opts.has('R')) {
          err(`rm: ${a}: is a directory (use -r)\n`);
          code = 1;
          continue;
        }
        await os.fs.rm(p, { recursive: true });
      }
      return code;
    },
  },
  {
    name: 'cp',
    summary: 'copy files or directories',
    usage: 'cp src… dest',
    async run({ args, os, path }) {
      const { rest } = flags(args);
      if (rest.length < 2) throw new Error('usage: cp src… dest');
      const dest = path(rest.pop()!);
      const destIsDir = (await os.fs.stat(dest))?.kind === 'dir';
      if (rest.length > 1 && !destIsDir) throw new Error(`target is not a directory: ${dest}`);
      for (const s of rest) await os.fs.cp(path(s), destIsDir ? join(dest, basename(path(s))) : dest);
    },
  },
  {
    name: 'mv',
    summary: 'move or rename',
    usage: 'mv src… dest',
    async run({ args, os, path }) {
      const { rest } = flags(args);
      if (rest.length < 2) throw new Error('usage: mv src… dest');
      const dest = path(rest.pop()!);
      const destIsDir = (await os.fs.stat(dest))?.kind === 'dir';
      if (rest.length > 1 && !destIsDir) throw new Error(`target is not a directory: ${dest}`);
      for (const s of rest) await os.fs.mv(path(s), destIsDir ? join(dest, basename(path(s))) : dest);
    },
  },
  {
    name: 'find',
    summary: 'find files by glob',
    usage: 'find [path] [-name glob] [-type f|d]',
    async run({ args, os, out, path, signal }) {
      const ni = args.indexOf('-name');
      const ti = args.indexOf('-type');
      const name = ni >= 0 ? args[ni + 1] : undefined;
      const type = ti >= 0 ? args[ti + 1] : undefined;
      const root = path(args[0] && !args[0].startsWith('-') ? args[0] : '.');
      const re = name ? new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
      for await (const s of os.fs.walk(root, { signal })) {
        if (re && !re.test(s.name)) continue;
        if (type && (type === 'd') !== (s.kind === 'dir')) continue;
        out(s.path + '\n');
      }
    },
  },
  {
    name: 'stat',
    summary: 'show file details',
    usage: 'stat path…',
    async run({ args, os, out, path }) {
      for (const a of args) {
        const s = await os.fs.stat(path(a));
        if (!s) throw new Error(`${a}: no such file or directory`);
        out(`  path: ${s.path}\n  kind: ${s.kind}\n  size: ${s.size} bytes\n mtime: ${s.mtime ? new Date(s.mtime).toISOString() : '-'}\n`);
      }
    },
  },
  {
    name: 'du',
    summary: 'disk usage of a directory',
    usage: 'du [path]',
    async run({ args, os, out, path, signal }) {
      const root = path(args[0] ?? '.');
      let bytes = 0;
      let files = 0;
      for await (const s of os.fs.walk(root, { signal })) {
        if (s.kind === 'file') {
          bytes += s.size;
          files++;
        }
      }
      out(`${fmtBytes(bytes)}\t${files} files\t${root}\n`);
    },
  },
  {
    name: 'df',
    summary: 'storage quota and mounts',
    async run({ os, out }) {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      out(`origin storage: ${fmtBytes(est?.usage ?? NaN)} used of ${fmtBytes(est?.quota ?? NaN)}\n\n`);
      for (const m of os.fs.mounts()) out(`${m.fs.label.padEnd(18)} ${m.fs.readonly ? 'ro' : 'rw'}  ${m.point}\n`);
    },
  },
  {
    name: 'mount',
    summary: 'mount a real folder from this computer under /mnt',
    async run({ os, out }) {
      out(`mounted at ${await os.mountNativeFolder()}\n`);
    },
  },
];
