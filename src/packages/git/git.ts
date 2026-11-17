import './buffer-global';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import type { KernelCore } from '@/kernel/kernel';
import { FsError } from '@/kernel/vfs/types';
import { flags, type Command, type CommandContext } from '@/shell/shell';
import { C } from '@/shell/ansi';

interface GitConfig {
  name: string;
  email: string;
  /** Relay for clone/fetch: Git hosts do not allow direct browser access. */
  corsProxy: string;
}
const CONFIG_KEY = 'git.config';
const DEFAULT: GitConfig = { name: 'BrowserBox User', email: 'user@browserbox.local', corsProxy: '' };

/** The slice of Node's fs.promises that isomorphic-git needs, backed by the virtual filesystem. */
function gitFs(os: KernelCore) {
  const fs = os.fs;
  const stat = async (path: string) => {
    const s = await fs.stat(path);
    if (!s) throw new FsError('ENOENT', path);
    const dir = s.kind === 'dir';
    return { type: dir ? 'dir' : 'file', mode: dir ? 0o40000 : 0o100644, size: s.size, ino: 0, mtimeMs: s.mtime, ctimeMs: s.mtime, uid: 1, gid: 1, dev: 1, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false };
  };
  return {
    promises: {
      readFile: async (path: string, opts?: string | { encoding?: string }) => {
        const enc = typeof opts === 'string' ? opts : opts?.encoding;
        const data = await fs.readFile(path);
        return enc === 'utf8' ? new TextDecoder().decode(data) : data;
      },
      writeFile: (path: string, data: string | Uint8Array) => fs.writeFile(path, data),
      unlink: (path: string) => fs.rm(path),
      readdir: async (path: string) => (await fs.readdir(path)).map((s) => s.name),
      mkdir: (path: string) => fs.mkdir(path),
      rmdir: (path: string) => fs.rm(path),
      stat,
      lstat: stat,
      readlink: async (path: string): Promise<string> => {
        throw new FsError('ENOENT', path);
      },
      symlink: async (_target: string, path: string): Promise<void> => {
        throw new FsError('EACCES', path, 'symbolic links are not supported');
      },
      chmod: async () => undefined,
    },
  };
}

/** Line diff via longest common subsequence — fine for source-sized files. */
function diffLines(a: string[], b: string[]): string[] {
  if (a.length * b.length > 4_000_000) return [`${C.dim}(file too large to diff: ${a.length} → ${b.length} lines)${C.reset}`];
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) i++, j++;
    else if (j < b.length && (i === a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) out.push(`${C.green}+${b[j++]}${C.reset}`);
    else out.push(`${C.red}-${a[i++]}${C.reset}`);
  }
  return out;
}

export const gitCommand: Command = {
  name: 'git',
  summary: 'version control (local repositories; clone needs a relay)',
  usage: 'git init | status | add <path…> | commit -m "msg" [-a] | log [-n N] [--oneline] | diff [path] | branch [name] | checkout [-b] <name> | clone <url> [dir] | config <key> [value]',
  async run(ctx: CommandContext) {
    const [sub, ...args] = ctx.args;
    const { os, out } = ctx;
    const fs = gitFs(os);
    const cfg = { ...DEFAULT, ...os.settings.get<Partial<GitConfig>>(CONFIG_KEY, {}) };
    const root = async () => {
      try {
        return await git.findRoot({ fs, filepath: ctx.shell.cwd });
      } catch {
        throw new Error('not a git repository (run `git init`)');
      }
    };
    const rel = (dir: string, p: string) => {
      const abs = ctx.path(p);
      return abs === dir ? '.' : abs.slice(dir.length + 1);
    };
    /** [path, head, workdir, stage] rows that differ from a clean checkout. */
    const changes = async (dir: string) => (await git.statusMatrix({ fs, dir })).filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1));

    switch (sub) {
      case 'init': {
        const dir = ctx.path(args[0] ?? '.');
        await git.init({ fs, dir, defaultBranch: 'main' });
        return void out(`Initialized empty Git repository in ${dir}/.git/\n`);
      }
      case 'config': {
        const map: Record<string, keyof GitConfig> = { 'user.name': 'name', 'user.email': 'email', 'http.corsProxy': 'corsProxy' };
        const key = args[0] ? map[args[0]] : undefined;
        if (!args[0]) return void out(Object.entries(map).map(([k, v]) => `${k}=${cfg[v]}`).join('\n') + '\n');
        if (!key) throw new Error(`unknown key (use ${Object.keys(map).join(', ')})`);
        if (args[1] === undefined) return void out(cfg[key] + '\n');
        return void os.settings.set(CONFIG_KEY, { ...cfg, [key]: args.slice(1).join(' ') });
      }
      case 'clone': {
        const url = args[0];
        if (!url) throw new Error('usage: git clone <url> [dir]');
        if (!cfg.corsProxy) throw new Error('Git hosts block direct access from browsers, so cloning needs a relay you trust.\nSet one with: git config http.corsProxy https://your-proxy.example\n(everything you clone passes through it)');
        const dir = ctx.path(args[1] ?? url.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/, ''));
        out(`Cloning into '${dir}'…\n`);
        await git.clone({ fs, http, dir, url, corsProxy: cfg.corsProxy, singleBranch: true, depth: 50, onMessage: (m) => out(C.dim + m + C.reset) });
        return void out('done.\n');
      }
      case 'status': {
        const dir = await root();
        out(`On branch ${(await git.currentBranch({ fs, dir })) ?? '(detached)'}\n`);
        const rows = await changes(dir);
        if (!rows.length) return void out('nothing to commit, working tree clean\n');
        for (const [path, h, w, s] of rows) {
          const staged = s !== h && !(h === 0 && s === 0);
          const label = h === 0 && s === 0 ? `${C.red}?? ` : w === 0 ? `${staged ? C.green : C.red}D  ` : h === 0 ? `${C.green}A  ` : `${staged && s === w ? C.green : C.red}M  `;
          out(`${label}${path}${C.reset}\n`);
        }
        return;
      }
      case 'add': {
        const dir = await root();
        if (!args.length) throw new Error('usage: git add <path…>');
        for (const a of args) {
          const prefix = rel(dir, a);
          for (const [path, , w] of await git.statusMatrix({ fs, dir, filepaths: [prefix] })) await (w === 0 ? git.remove({ fs, dir, filepath: path }) : git.add({ fs, dir, filepath: path }));
        }
        return;
      }
      case 'commit': {
        const dir = await root();
        const mi = args.indexOf('-m');
        const message = mi >= 0 ? args[mi + 1] : undefined;
        if (!message) throw new Error('usage: git commit -m "message" [-a]');
        if (flags(args).opts.has('a')) for (const [path, h, w] of await changes(dir)) if (h === 1) await (w === 0 ? git.remove({ fs, dir, filepath: path }) : git.add({ fs, dir, filepath: path }));
        if (!(await changes(dir)).some(([, h, , s]) => s !== h)) throw new Error('nothing staged to commit (use `git add`)');
        const sha = await git.commit({ fs, dir, message, author: { name: cfg.name, email: cfg.email } });
        return void out(`[${(await git.currentBranch({ fs, dir })) ?? 'detached'} ${sha.slice(0, 7)}] ${message}\n`);
      }
      case 'log': {
        const dir = await root();
        const ni = args.indexOf('-n');
        const commits = await git.log({ fs, dir, depth: ni >= 0 ? Number(args[ni + 1]) || 10 : 20 });
        for (const c of commits) {
          if (args.includes('--oneline')) out(`${C.yellow}${c.oid.slice(0, 7)}${C.reset} ${c.commit.message.split('\n')[0]}\n`);
          else out(`${C.yellow}commit ${c.oid}${C.reset}\nAuthor: ${c.commit.author.name} <${c.commit.author.email}>\nDate:   ${new Date(c.commit.author.timestamp * 1000).toISOString()}\n\n    ${c.commit.message.trim().replace(/\n/g, '\n    ')}\n\n`);
        }
        return;
      }
      case 'diff': {
        const dir = await root();
        const only = args[0] ? rel(dir, args[0]) : null;
        for (const [path, h, w] of await changes(dir)) {
          if (only && path !== only && !path.startsWith(only + '/')) continue;
          const before = h === 1 ? new TextDecoder().decode((await git.readBlob({ fs, dir, oid: await git.resolveRef({ fs, dir, ref: 'HEAD' }), filepath: path })).blob) : '';
          const after = w === 0 ? '' : await os.fs.readText(`${dir}/${path}`);
          out(`${C.bold}--- ${h === 1 ? 'a/' + path : '/dev/null'}\n+++ ${w === 0 ? '/dev/null' : 'b/' + path}${C.reset}\n${diffLines(before ? before.split('\n') : [], after ? after.split('\n') : []).join('\n')}\n`);
        }
        return;
      }
      case 'branch': {
        const dir = await root();
        if (args[0]) return void (await git.branch({ fs, dir, ref: args[0] }));
        const current = await git.currentBranch({ fs, dir });
        for (const b of await git.listBranches({ fs, dir })) out(`${b === current ? `${C.green}* ` : '  '}${b}${C.reset}\n`);
        return;
      }
      case 'checkout': {
        const dir = await root();
        const create = args[0] === '-b';
        const ref = create ? args[1] : args[0];
        if (!ref) throw new Error('usage: git checkout [-b] <branch>');
        if (create) await git.branch({ fs, dir, ref });
        await git.checkout({ fs, dir, ref });
        return void out(`Switched to ${create ? 'a new ' : ''}branch '${ref}'\n`);
      }
      default:
        throw new Error(sub ? `unsupported git command: ${sub}\n${this.usage}` : `usage: ${this.usage}`);
    }
  },
};
