import { INSTALLED_KEY } from '../../kernel/packages';
import { fmtBytes } from '../../kernel/format';
import { C } from '../ansi';
import type { Command, CommandContext } from '../shell';

/** A one-line progress bar, redrawn in place with a carriage return. */
export function progressBar(label: string, out: (t: string) => void): (loaded: number, total: number) => void {
  let last = -1;
  return (loaded, total) => {
    const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
    if (pct === last) return;
    last = pct;
    const width = 24;
    const fill = Math.round((pct / 100) * width);
    out(`\r${label.padEnd(8)} [${'#'.repeat(fill)}${'.'.repeat(width - fill)}] ${String(pct).padStart(3)}%  ${fmtBytes(loaded)}${total ? ` / ${fmtBytes(total)}` : ''}`);
  };
}

async function install(ctx: CommandContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    const bar = progressBar(id, ctx.out);
    await ctx.os.packages.install(id, bar);
    ctx.out(`\n${C.green}installed${C.reset} ${id}\n`);
  }
}

export const pkgCommand: Command = {
  name: 'pkg',
  summary: 'package manager: list, info, install, remove',
  usage: 'pkg list | pkg info <name> | pkg install <name>… | pkg install --defaults | pkg remove <name>…',
  async run(ctx) {
    const { os, out } = ctx;
    const [verb = 'list', ...names] = ctx.args;
    if (verb === 'list') {
      for (const p of await os.packages.list()) {
        out(`${p.installed ? `${C.green}i${C.reset}` : ' '} ${C.bold}${p.id.padEnd(8)}${C.reset} ${(p.bytes ? `${p.estimated ? '~' : ''}${fmtBytes(p.bytes)}` : '').padStart(9)}  ${p.summary}\n`);
      }
      return out(`${C.dim}i = installed · pkg install <name>${C.reset}\n`);
    }
    if (verb === 'info') {
      const p = (await os.packages.list()).find((x) => x.id === names[0]);
      if (!p) throw new Error(`no such package: ${names[0] ?? ''}`);
      out(`${C.bold}${p.id}${C.reset} ${p.version}\n${p.summary}\nstatus:   ${p.installed ? 'installed' : 'not installed'}\nsize:     ${p.bytes ? `${p.estimated ? 'about ' : ''}${fmtBytes(p.bytes)}` : 'unknown until downloaded'}\ncommands: ${p.commands.join(', ') || '—'}\ntools:    ${p.tools.join(', ') || '—'}\n`);
      return;
    }
    if (verb === 'install') {
      // --defaults: the packages a new system gets (Python only on request).
      if (names.includes('--defaults')) return install(ctx, defaultPackages(os).filter((id) => !os.packages.isInstalled(id)));
      if (!names.length) throw new Error('usage: pkg install <name>… | pkg install --defaults');
      return install(ctx, names);
    }
    if (verb === 'remove') {
      for (const id of names) {
        await os.packages.remove(id);
        out(`removed ${id}\n`);
      }
      return;
    }
    throw new Error(`usage: ${this.usage}`);
  },
};

export const dmesgCommand: Command = {
  name: 'dmesg',
  summary: 'print the kernel log',
  async run({ os, out }) {
    for (const l of os.kernelLog) out(`${C.dim}[${(l.t / 1000).toFixed(3).padStart(9)}]${C.reset} ${l.src}: ${l.msg}\n`);
  },
};

/** Packages selected at first boot (kept so `setup` can offer the same choice again). */
export const defaultPackages = (os: CommandContext['os']) => os.packages.manifests().filter((p) => p.default).map((p) => p.id);
export { INSTALLED_KEY, install as installPackages };
