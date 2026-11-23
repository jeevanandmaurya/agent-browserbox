import { compareVersions, INSTALLED_KEY, validatePackage, type ExternalPackage, type Listed } from '../../kernel/packages';
import { fmtBytes } from '../../kernel/format';
import { C } from '../ansi';
import { LOCAL_BIN } from '../runners';
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

/** A person at the terminal says yes. Programs and the agent never can. */
async function confirm(ctx: CommandContext, question: string): Promise<boolean> {
  if (!ctx.shell.tty?.interactive) return false;
  const a = await ctx.shell.tty.readLine(`${question} [y/N] `);
  return /^y(es)?$/i.test(a?.trim() ?? '');
}

const describe = (p: ExternalPackage) => {
  const bytes = p.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
  return `${p.id} ${p.version} (${p.kind}${bytes ? `, ${fmtBytes(bytes)}` : ''}): commands ${Object.keys(p.commands).join(', ')}${p.depends?.length ? `; needs ${p.depends.join(', ')}` : ''}`;
};

async function install(ctx: CommandContext, ids: string[]): Promise<void> {
  const { os, out } = ctx;
  for (const id of ids) {
    // A link to a bbx-package.json: a one-off install, always asked.
    if (/^https?:\/\//.test(id)) {
      if (!ctx.shell.tty?.interactive) throw new Error('installing from a link must be confirmed by a person in a terminal');
      const res = await fetch(id);
      if (!res.ok) throw new Error(`could not fetch ${id} (HTTP ${res.status})`);
      const pkg = validatePackage(await res.json());
      out(`${C.bold}${describe(pkg)}${C.reset}\nfrom ${id}\n${C.yellow}This package is not in the BrowserBox index: its code has not been checked.${C.reset}\n`);
      if (!(await confirm(ctx, 'Install it?'))) return void out('Not installed.\n');
      await os.packages.installExternal(pkg, id, progressBar(pkg.id, out));
      out(`\n${C.green}installed${C.reset} ${pkg.id}\n`);
      continue;
    }
    if (!os.packages.manifests().some((m) => m.id === id)) {
      const [name, version] = id.split('@') as [string, string | undefined];
      const found = await os.packages.find(name, { version });
      if (!found) throw new Error(`no such package: ${id} (see pkg search)`);
      // Sources other than the BrowserBox index: only a person installs from them.
      if (!found.official && !ctx.shell.tty?.interactive) throw new Error(`${found.id} comes from ${found.source}, not the BrowserBox index: only a person can install it, in a terminal`);
      if (!found.official) {
        out(`${C.bold}${describe(found)}${C.reset}\nfrom ${found.source}\n`);
        if (!(await confirm(ctx, 'Install it?'))) return void out('Not installed.\n');
      }
      const added = await os.packages.installExternal(found, found.source, progressBar(found.id, out));
      out(`\n${C.green}installed${C.reset} ${added.join(', ')}\n`);
      continue;
    }
    await os.packages.install(id, progressBar(id, out));
    out(`\n${C.green}installed${C.reset} ${id}\n`);
  }
}

const tag = (p: Listed) => (p.official ? '' : ` ${C.dim}[${new URL(p.source).host}]${C.reset}`);

export const pkgCommand: Command = {
  name: 'pkg',
  summary: 'package manager: search, install, remove, upgrade, sources',
  usage: 'pkg list [--installed] | search <words> | info <id> | install <id>[@version]|<url>|--defaults … | remove <id>… [--force] | update | upgrade [id…] | files <id> | verify [id…] | why <command> | source [list|add <url>|remove <url>]',
  async run(ctx) {
    const { os, out } = ctx;
    const [verb = 'list', ...rest] = ctx.args;
    const names = rest.filter((a) => !a.startsWith('--'));
    const flag = (f: string) => rest.includes(`--${f}`);

    if (verb === 'list') {
      const ext = os.packages.externals();
      for (const p of await os.packages.list()) {
        if (flag('installed') && !p.installed) continue;
        out(`${p.installed ? `${C.green}i${C.reset}` : ' '} ${C.bold}${p.id.padEnd(10)}${C.reset} ${(p.bytes ? `${p.estimated ? '~' : ''}${fmtBytes(p.bytes)}` : '').padStart(9)}  ${p.summary} ${C.dim}(built in)${C.reset}\n`);
      }
      const seen = new Set<string>();
      for (const p of (await os.packages.index()).sort((a, b) => a.id.localeCompare(b.id) || compareVersions(b.version, a.version))) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const installed = ext[p.id];
        if (flag('installed') && !installed) continue;
        const bytes = p.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
        out(`${installed ? `${C.green}i${C.reset}` : ' '} ${C.bold}${p.id.padEnd(10)}${C.reset} ${(bytes ? fmtBytes(bytes) : '').padStart(9)}  ${p.summary} ${C.dim}(${p.kind} ${installed?.pkg.version ?? p.version})${C.reset}${tag(p)}\n`);
      }
      return out(`${C.dim}i = installed · pkg search <words> · pkg install <name>${C.reset}\n`);
    }

    if (verb === 'search') {
      const words = names.map((w) => w.toLowerCase());
      if (!words.length) throw new Error('usage: pkg search <words>');
      const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
      let n = 0;
      for (const m of os.packages.manifests()) if (hit(`${m.id} ${m.summary} ${m.commands.join(' ')}`)) (n++, out(`${C.bold}${m.id}${C.reset} ${C.dim}(built in)${C.reset} ${m.summary}\n`));
      const seen = new Set<string>();
      for (const p of await os.packages.index()) {
        if (seen.has(p.id) || !hit(`${p.id} ${p.summary} ${Object.keys(p.commands).join(' ')}`)) continue;
        seen.add(p.id);
        n++;
        out(`${C.bold}${p.id}${C.reset} ${C.dim}(${p.kind} ${p.version})${C.reset}${tag(p)} ${p.summary}\n`);
      }
      if (!n) out('Nothing found. pkg update refreshes the indexes.\n');
      return;
    }

    if (verb === 'info') {
      const id = names[0] ?? '';
      const b = (await os.packages.list()).find((x) => x.id === id);
      if (b) {
        out(`${C.bold}${b.id}${C.reset} ${b.version} (built in)\n${b.summary}\nstatus:   ${b.installed ? 'installed' : 'not installed'}\nsize:     ${b.bytes ? `${b.estimated ? 'about ' : ''}${fmtBytes(b.bytes)}` : 'unknown until downloaded'}\ncommands: ${b.commands.join(', ') || '—'}\ntools:    ${b.tools.join(', ') || '—'}\n`);
        return;
      }
      const rec = os.packages.externals()[id];
      const p = rec?.pkg ?? (await os.packages.find(id));
      if (!p) throw new Error(`no such package: ${id}`);
      const newest = await os.packages.find(id);
      out(
        `${C.bold}${p.id}${C.reset} ${p.version} (${p.kind})\n${p.summary}\nstatus:   ${rec ? `installed from ${rec.source}${newest && compareVersions(newest.version, rec.pkg.version) > 0 ? ` (${newest.version} available: pkg upgrade ${id})` : ''}` : 'not installed'}\n` +
          `commands: ${Object.keys(p.commands).join(', ')}\nneeds:    ${p.depends?.join(', ') || '—'}\nlicence:  ${p.license ?? '—'}\nhome:     ${p.homepage ?? '—'}\nsize:     ${fmtBytes(p.files.reduce((n, f) => n + (f.bytes ?? 0), 0))} in ${p.files.length} file${p.files.length > 1 ? 's' : ''}\n`,
      );
      return;
    }

    if (verb === 'install') {
      // --defaults: the packages a new system gets (Python only on request).
      if (flag('defaults')) return install(ctx, defaultPackages(os).filter((id) => !os.packages.isInstalled(id)));
      if (!names.length) throw new Error('usage: pkg install <name>… | pkg install --defaults');
      return install(ctx, names);
    }

    if (verb === 'remove') {
      if (!names.length) throw new Error('usage: pkg remove <name>… [--force]');
      for (const id of names) {
        await os.packages.remove(id, { force: flag('force') });
        out(`removed ${id}\n`);
      }
      return;
    }

    if (verb === 'update') {
      const all = await os.packages.index(true);
      const up = await os.packages.upgradable();
      out(`${new Set(all.map((p) => p.id)).size} packages in ${os.packages.sources().length} source${os.packages.sources().length > 1 ? 's' : ''}.${up.length ? ` Upgradable: ${up.map((u) => `${u.id} ${u.from} → ${u.to.version}`).join(', ')} (pkg upgrade)` : ''}\n`);
      return;
    }

    if (verb === 'upgrade') {
      const up = (await os.packages.upgradable()).filter((u) => !names.length || names.includes(u.id));
      if (!up.length) return void out('Everything is up to date.\n');
      for (const u of up) {
        if (!u.to.official && !ctx.shell.tty?.interactive) throw new Error(`${u.id} comes from ${u.to.source}: only a person can upgrade it, in a terminal`);
        await os.packages.installExternal(u.to, u.to.source, progressBar(u.id, out));
        out(`\n${C.green}upgraded${C.reset} ${u.id} ${u.from} → ${u.to.version}\n`);
      }
      return;
    }

    if (verb === 'files') {
      const rec = os.packages.externals()[names[0] ?? ''];
      if (!rec) {
        if (os.packages.manifests().some((m) => m.id === names[0])) return void out(`${names[0]} is built into BrowserBox: its code is part of the runtime.\n`);
        throw new Error(`${names[0] ?? ''} is not installed`);
      }
      for (const f of rec.pkg.files) out(`${f.path}  ${f.bytes ? fmtBytes(f.bytes).padStart(8) : ''}  sha256 ${f.sha256.slice(0, 16)}…  ${C.dim}${f.url}${C.reset}\n`);
      return;
    }

    if (verb === 'verify') {
      const bad = await os.packages.verify(names);
      if (!bad.length) return void out(`${C.green}ok${C.reset}: every file matches its sha256\n`);
      for (const b of bad) out(`${C.red}${b.problem}${C.reset} ${b.id}: ${b.path}\n`);
      out(`Reinstall with: pkg install ${[...new Set(bad.map((b) => b.id))].join(' ')}\n`);
      return 1;
    }

    if (verb === 'why') {
      const name = names[0];
      if (!name) throw new Error('usage: pkg why <command>');
      const builtin = os.packages.manifests().find((m) => m.commands.includes(name));
      if (builtin) return void out(`${name}: from the ${builtin.id} package (built in${os.packages.isInstalled(builtin.id) ? '' : ', not installed'})\n`);
      const ext = os.packages.externalCommand(name);
      if (ext) return void out(`${name}: from the ${ext.pkg.id} package ${ext.pkg.version} (${ext.pkg.kind}), runs ${ext.entry.run}\n`);
      if (await os.fs.exists(`${LOCAL_BIN}/${name}`).catch(() => false)) return void out(`${name}: your command in ${LOCAL_BIN}\n`);
      const listed = await os.packages.providerInIndex(name);
      if (listed) return void out(`${name}: in the ${listed.id} package, not installed (pkg install ${listed.id})\n`);
      return void out(`${name}: built into the shell, or not known\n`);
    }

    if (verb === 'source') {
      const [sub = 'list', url] = names;
      if (sub === 'list') {
        for (const s of os.packages.sources()) out(`${s.url}${s.official ? ` ${C.dim}(BrowserBox index)${C.reset}` : ''}\n`);
        return;
      }
      if (!url) throw new Error('usage: pkg source add <url> | pkg source remove <url>');
      if (sub === 'add') {
        if (!ctx.shell.tty?.interactive) throw new Error('only a person can add a package source, in a terminal');
        out(`${C.yellow}Packages from ${new URL(url).host} are not checked by BrowserBox. You will still be asked before each install.${C.reset}\n`);
        if (!(await confirm(ctx, `Add ${url} as a package source?`))) return void out('Not added.\n');
        os.packages.addSource(url);
        const all = await os.packages.index(true);
        return void out(`Added. ${all.filter((p) => p.source === new URL(url).href).length} packages from it.\n`);
      }
      if (sub === 'remove') {
        os.packages.removeSource(new URL(url).href);
        return void out('Removed. Packages installed from it stay installed.\n');
      }
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
