import { dirname, join } from '@/kernel/vfs/path';
import { flags, type Command, type CommandContext } from '@/shell/shell';
import { fmtBytes } from '@/ui/dom';
import { unzipSync, zipSync } from 'fflate';
import type { PackageModule } from '../types';

const zip: Command = {
  name: 'zip',
  summary: 'create a zip archive',
  usage: 'zip [-r] archive.zip path…',
  async run(ctx: CommandContext) {
    const { rest } = flags(ctx.args);
    const target = rest.shift();
    if (!target || !rest.length) throw new Error('usage: zip [-r] archive.zip path…');
    const files: Record<string, Uint8Array> = {};
    for (const arg of rest) {
      const root = ctx.path(arg);
      const st = await ctx.os.fs.stat(root);
      if (!st) throw new Error(`${arg}: no such file or directory`);
      const base = dirname(root) === '/' ? '/' : dirname(root) + '/';
      if (st.kind === 'file') files[root.slice(base.length)] = await ctx.os.fs.readFile(root);
      else for await (const s of ctx.os.fs.walk(root, { signal: ctx.signal })) if (s.kind === 'file') files[s.path.slice(base.length)] = await ctx.os.fs.readFile(s.path);
    }
    const data = zipSync(files);
    await ctx.os.fs.writeFile(ctx.path(target), data);
    ctx.out(`${Object.keys(files).length} files → ${target} (${fmtBytes(data.length)})\n`);
  },
};

const unzip: Command = {
  name: 'unzip',
  summary: 'list or extract a zip archive',
  usage: 'unzip [-l] archive.zip [-d dir]',
  async run(ctx: CommandContext) {
    const di = ctx.args.indexOf('-d');
    const dest = ctx.path(di >= 0 ? (ctx.args[di + 1] ?? '.') : '.');
    const rest = ctx.args.filter((a, i) => a !== '-l' && i !== di && i !== di + 1);
    if (!rest[0]) throw new Error('usage: unzip [-l] archive.zip [-d dir]');
    const entries = unzipSync(await ctx.os.fs.readFile(ctx.path(rest[0])));
    let n = 0;
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      n++;
      if (ctx.args.includes('-l')) ctx.out(`${String(data.length).padStart(10)}  ${name}\n`);
      // join() normalises "..", so an entry can never escape the destination.
      else await ctx.os.fs.writeFile(join(dest, join('/', name)), data);
    }
    ctx.out(`${n} file${n === 1 ? '' : 's'}${ctx.args.includes('-l') ? '' : ` extracted to ${dest}`}\n`);
  },
};

export default { commands: [zip, unzip] } satisfies PackageModule;
