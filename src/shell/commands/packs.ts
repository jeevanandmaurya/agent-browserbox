import { DEFAULT_PACKS, PACKS, PACKS_KEY } from '@/agent/packs';
import type { KernelCore } from '@/kernel/kernel';
import { dirname, join } from '@/kernel/vfs/path';
import { fmtBytes } from '@/ui/dom';
import { flags, type Command, type CommandContext } from '../shell';
import { C } from '../ansi';
import { gitCommand } from './git';

export const installed = (os: KernelCore): string[] => os.settings.get<string[]>(PACKS_KEY, DEFAULT_PACKS);

/** Reports a download at each 20% step, as plain lines. */
export function stepProgress(label: string, write: (line: string) => void): (loaded: number, bytes: number) => void {
  let shown = -1;
  return (loaded, bytes) => {
    const step = bytes ? Math.floor((loaded / bytes) * 5) : -1;
    if (step > shown) {
      shown = step;
      write(`${C.dim}downloading ${label}: ${step * 20}% of ${fmtBytes(bytes)}${C.reset}\n`);
    }
  };
}

/** Wraps a command so it only runs when its pack is installed. */
export function fromPack(pack: string, cmd: Command): Command {
  return {
    ...cmd,
    async run(ctx) {
      if (!installed(ctx.os).includes(pack)) throw new Error(`the ${pack} pack is not installed. Run: pkg install ${pack}`);
      await ctx.os.packs.ensure(pack, stepProgress(pack, (line) => ctx.err(line)));
      return cmd.run(ctx);
    },
  };
}

const pkg: Command = {
  name: 'pkg',
  summary: 'list, install or remove tool packs',
  usage: 'pkg list | pkg install <pack>… | pkg remove <pack>…',
  async run({ args, os, out }) {
    const [verb = 'list', ...names] = args;
    if (verb === 'list') {
      for (const p of await os.packs.list()) {
        const status = !p.available ? `${C.dim}planned     ${C.reset}` : p.selected && p.cached ? `${C.green}installed   ${C.reset}` : p.selected ? `${C.yellow}on first use${C.reset}` : '            ';
        out(`${status}  ${C.bold}${p.id.padEnd(8)}${C.reset} ${(p.bytes ? fmtBytes(p.bytes) : 'size unknown').padEnd(12)} ${C.dim}${p.description}${C.reset}\n`);
      }
      return;
    }
    if (verb !== 'install' && verb !== 'remove') throw new Error('usage: pkg list | pkg install <pack>… | pkg remove <pack>…');
    if (!names.length) throw new Error(`usage: pkg ${verb} <pack>…`);
    for (const name of names) {
      if (verb === 'remove') {
        await os.packs.remove(name);
        out(`removed ${name}\n`);
        continue;
      }
      // Print progress at each 10% step; a terminal here cannot redraw a line in place.
      let shown = -1;
      await os.packs.install(name, (loaded, bytes) => {
        const step = bytes ? Math.floor((loaded / bytes) * 10) : -1;
        if (step > shown && step < 10) {
          shown = step;
          out(`${C.dim}${name}: ${step * 10}% of ${fmtBytes(bytes)}${C.reset}\n`);
        }
      });
      const state = (await os.packs.list()).find((p) => p.id === name);
      out(`installed ${name}${state?.bytes ? ` (${fmtBytes(state.bytes)})` : ''}\n`);
    }
  },
};

// ---- zip --------------------------------------------------------------------

const zip: Command = {
  name: 'zip',
  summary: 'create a zip archive',
  usage: 'zip [-r] archive.zip path…',
  async run(ctx: CommandContext) {
    const { rest } = flags(ctx.args);
    const target = rest.shift();
    if (!target || !rest.length) throw new Error('usage: zip [-r] archive.zip path…');
    const { zipSync } = await import('fflate');
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
    const { unzipSync } = await import('fflate');
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

// ---- sqlite -----------------------------------------------------------------

const sqlite3: Command = {
  name: 'sqlite3',
  summary: 'query a SQLite database file',
  usage: 'sqlite3 [-header] file.db "SQL"   (or pipe SQL in; .tables and .schema work)',
  async run(ctx: CommandContext) {
    const header = ctx.args.includes('-header');
    const rest = ctx.args.filter((a) => a !== '-header');
    const file = rest[0];
    let sql = (rest.slice(1).join(' ') || ctx.stdin).trim();
    if (!file || !sql) throw new Error('usage: sqlite3 [-header] file.db "SQL"');
    if (sql === '.tables') sql = "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name";
    else if (sql.startsWith('.schema')) sql = 'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name';
    else if (sql.startsWith('.')) throw new Error(`unsupported dot-command: ${sql.split(' ')[0]}`);
    const [{ default: init }, { default: wasmUrl }] = await Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')]);
    const SQL = await init({ locateFile: () => wasmUrl });
    const path = ctx.path(file);
    const existing = await ctx.os.fs.readFile(path).catch(() => null);
    const db = new SQL.Database(existing ?? undefined);
    try {
      for (const result of db.exec(sql)) {
        if (header) ctx.out(result.columns.join('|') + '\n');
        for (const row of result.values) ctx.out(row.map((v) => (v === null ? '' : v instanceof Uint8Array ? `<blob ${v.length}>` : String(v))).join('|') + '\n');
      }
      // Persist when the statement changed the database (or created it).
      if (db.getRowsModified() > 0 || !existing || /^\s*(create|drop|alter|insert|update|delete|replace|vacuum)/i.test(sql)) await ctx.os.fs.writeFile(path, db.export());
    } finally {
      db.close();
    }
  },
};

export const packCommands: Command[] = [pkg, fromPack('zip', zip), fromPack('zip', unzip), fromPack('sqlite', sqlite3), fromPack('git', gitCommand)];
