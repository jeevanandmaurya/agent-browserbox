import type { Command, CommandContext } from '@/shell/shell';
import init from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { PackageModule } from '../types';

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

export default { commands: [sqlite3] } satisfies PackageModule;
