import type { DevLog } from '@/kernel/dev/types';
import { pinVersion, splitSpecifier } from '@/kernel/dev/npm';
import { basename, join } from '@/kernel/vfs/path';
import { C } from '../ansi';
import { runInNode } from './noderun';
import type { Command, CommandContext } from '../shell';
import { progressBar } from './pkg';

/** `--port 3000`, `--port=3000` and bare flags. */
function parse(args: string[]): { flags: Set<string>; values: Map<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) rest.push(a);
    else if (m[2] !== undefined) values.set(m[1]!, m[2]);
    else if ((m[1] === 'port' || m[1] === 'p') && args[i + 1] && /^\d+$/.test(args[i + 1]!)) values.set('port', args[++i]!);
    else flags.add(m[1]!);
  }
  return { flags, values, rest };
}

/** Whether a project will need the bundler: modules, TypeScript, JSX or npm packages. */
async function needsBundler(ctx: CommandContext, root: string): Promise<boolean> {
  const fs = ctx.os.fs;
  const html = await fs.readText(join(root, 'index.html')).catch(() => null);
  if (html === null || /<script[^>]+type\s*=\s*["']?module/i.test(html)) return true;
  return (await fs.glob('**/*.{ts,tsx,jsx}', root, 1)).length > 0 || (await fs.exists(join(root, 'package.json')));
}

const LEVEL: Record<DevLog['level'], string> = { error: C.red, warn: C.yellow, info: C.cyan, log: '', debug: C.dim };

export function formatLog(l: DevLog): string {
  const time = new Date(l.t).toTimeString().slice(0, 8);
  return `${C.dim}${time} ${l.source.padEnd(7)}${C.reset} ${LEVEL[l.level]}${l.text}${C.reset}\n`;
}

async function startServer(ctx: CommandContext, root: string, opts: { port?: number; network?: boolean; open?: boolean }): Promise<number> {
  const { os, out } = ctx;
  if (!os.packages.isInstalled('esbuild') && (await needsBundler(ctx, root))) {
    out(`${C.dim}this project needs the bundler: installing esbuild${C.reset}\n`);
    await os.packages.install('esbuild', progressBar('esbuild', out));
    out('\n');
  }
  const info = await os.dev.start({ root, port: opts.port, network: opts.network });
  out(`\n  ${C.green}${C.bold}serving${C.reset} ${info.root}\n`);
  out(`  ${C.bold}➜${C.reset}  ${C.cyan}${info.url}${C.reset}  ${C.dim}opens in Preview${C.reset}\n`);
  if (info.backend) out(`  ${C.dim}backend${C.reset}  ${info.backend}${info.network ? ' (network allowed)' : ' (no network: serve --net to allow)'}\n`);
  out(`  ${C.dim}npm packages load from esm.sh · files reload on save · serve logs ${info.port} · serve stop ${info.port}${C.reset}\n\n`);
  if (opts.open !== false) os.openApp('preview', { dev: info.port });
  return info.port;
}

export const serveCommand: Command = {
  name: 'serve',
  summary: 'dev server for a project folder: bundles TS/JSX, reloads on save, runs server.ts',
  usage: 'serve [dir] [--port N] [--net] [--no-open]  |  serve list  |  serve logs [port]  |  serve stop [port|all]',
  async run(ctx) {
    const { os, out } = ctx;
    const { flags, values, rest } = parse(ctx.args);
    const [verb] = rest;
    const servers = await os.dev.list();
    const pick = (arg?: string) => {
      const port = arg ? Number(arg) : servers.length === 1 ? servers[0]!.port : NaN;
      if (!Number.isFinite(port)) throw new Error(servers.length ? `which server? ${servers.map((s) => s.port).join(', ')}` : 'nothing is being served');
      return port;
    };
    if (verb === 'list' || verb === 'ls') {
      if (!servers.length) return out(`${C.dim}nothing is being served. Start one: serve [dir]${C.reset}\n`);
      for (const s of servers) out(`${C.cyan}${s.url.padEnd(24)}${C.reset} ${s.root}${s.backend ? `  ${C.dim}backend ${s.backend}${C.reset}` : ''}\n`);
      return;
    }
    if (verb === 'stop') {
      const which = rest[1] === 'all' ? servers.map((s) => s.port) : [pick(rest[1])];
      for (const port of which) out((await os.dev.stop(port)) ? `stopped :${port}\n` : `nothing on :${port}\n`);
      return;
    }
    if (verb === 'logs' || verb === 'log') {
      const logs = await os.dev.logs(pick(rest[1]), { limit: Number(values.get('n') ?? 100) });
      if (!logs.length) out(`${C.dim}no output yet${C.reset}\n`);
      for (const l of logs) out(formatLog(l));
      return;
    }
    if (verb === 'open') {
      os.openApp('preview', { dev: pick(rest[1]) });
      return;
    }
    const port = values.has('port') ? Number(values.get('port')) : undefined;
    if (port !== undefined && !(port > 0 && port < 65536)) throw new Error('--port must be a number between 1 and 65535');
    await startServer(ctx, ctx.path(verb ?? '.'), { port, network: flags.has('net'), open: !flags.has('no-open') });
  },
};

// ---- npm ----------------------------------------------------------------------

interface Pkg {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPkg(ctx: CommandContext): Promise<Pkg | null> {
  const t = await ctx.os.fs.readText(join(ctx.shell.cwd, 'package.json')).catch(() => null);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Pkg;
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${(err as Error).message}`);
  }
}
const writePkg = (ctx: CommandContext, pkg: Pkg) => ctx.os.fs.writeFile(join(ctx.shell.cwd, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
const newPkg = (ctx: CommandContext): Pkg => ({ name: basename(ctx.shell.cwd).toLowerCase().replace(/[^a-z0-9-_.]/g, '-') || 'app', version: '0.1.0', private: true, type: 'module', scripts: { dev: 'serve' }, dependencies: {} });

/** The latest version of a package, from the npm registry. */
async function latest(name: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
  } catch {
    throw new Error(`could not reach the npm registry to look up ${name} (offline?)`);
  }
  if (res.status === 404) throw new Error(`no such package on npm: ${name}`);
  if (!res.ok) throw new Error(`npm registry: HTTP ${res.status} for ${name}`);
  return ((await res.json()) as { version: string }).version;
}

/** Real Node.js, when the node package is installed and the page is cross-origin isolated. */
async function realNode(ctx: CommandContext) {
  return ctx.os.packages.isInstalled('node') ? runInNode : null;
}

const DEV_SCRIPTS = /\b(vite|next|webpack|parcel|serve|http-server|live-server|react-scripts|astro|nuxt|svelte-kit)\b/;

export const npmCommand: Command = {
  name: 'npm',
  summary: 'manage package.json; npm run dev serves the project (packages load from esm.sh)',
  usage: 'npm init | npm install <pkg>[@version]… [-D] | npm uninstall <pkg>… | npm ls | npm run dev',
  async run(ctx) {
    // With the node package, npm is the real one (WebContainers).
    const real = await realNode(ctx);
    if (real) return real(ctx, 'npm', ctx.args);
    const { out } = ctx;
    const { flags, rest } = parse(ctx.args);
    const [verb = 'help', ...names] = rest;
    switch (verb) {
      case 'init': {
        if (await readPkg(ctx)) return out('package.json already exists\n');
        await writePkg(ctx, newPkg(ctx));
        return out(`wrote ${join(ctx.shell.cwd, 'package.json')}\n`);
      }
      case 'install':
      case 'i':
      case 'add': {
        const pkg = (await readPkg(ctx)) ?? newPkg(ctx);
        if (!names.length) {
          return out(`${C.dim}nothing to download: packages listed in package.json load from esm.sh when the app is bundled, and are cached after that.${C.reset}\n`);
        }
        const field = flags.has('D') || flags.has('save-dev') ? 'devDependencies' : 'dependencies';
        const deps = (pkg[field] ??= {});
        for (const spec of names) {
          const at = spec.lastIndexOf('@');
          const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, ''];
          if (!splitSpecifier(name)[0]) throw new Error(`not a package name: ${spec}`);
          const v = pinVersion(version) ?? (await latest(name));
          deps[name] = `^${v}`;
          out(`${C.green}+${C.reset} ${name}@${v}\n`);
        }
        await writePkg(ctx, pkg);
        return out(`${C.dim}saved to package.json · loaded from esm.sh when the app is bundled${C.reset}\n`);
      }
      case 'uninstall':
      case 'remove':
      case 'rm':
      case 'un': {
        const pkg = await readPkg(ctx);
        if (!pkg) throw new Error('no package.json here');
        for (const n of names) {
          const had = !!(pkg.dependencies?.[n] ?? pkg.devDependencies?.[n]);
          delete pkg.dependencies?.[n];
          delete pkg.devDependencies?.[n];
          out(had ? `${C.red}-${C.reset} ${n}\n` : `${n} was not a dependency\n`);
        }
        return writePkg(ctx, pkg);
      }
      case 'ls':
      case 'list': {
        const pkg = await readPkg(ctx);
        const all = { ...pkg?.dependencies, ...pkg?.devDependencies };
        if (!Object.keys(all).length) return out(`${C.dim}no dependencies${C.reset}\n`);
        for (const [n, v] of Object.entries(all)) out(`${n}@${v}\n`);
        return;
      }
      case 'start':
      case 'run':
      case 'run-script': {
        const script = verb === 'start' ? 'start' : names[0];
        const pkg = await readPkg(ctx);
        if (!script) return out(Object.entries(pkg?.scripts ?? {}).map(([k, v]) => `  ${k}: ${v}\n`).join('') || `${C.dim}no scripts${C.reset}\n`);
        const cmd = pkg?.scripts?.[script] ?? '';
        if (['dev', 'start', 'serve', 'preview'].includes(script) || DEV_SCRIPTS.test(cmd)) {
          await startServer(ctx, ctx.shell.cwd, { open: true });
          return;
        }
        if (!cmd) throw new Error(`no script "${script}" in package.json`);
        out(`${C.dim}> ${cmd}${C.reset}\n`);
        return ctx.shell.run(cmd, { out: ctx.out, err: ctx.err, signal: ctx.signal });
      }
      default:
        out(`${npmCommand.usage}\n${C.dim}There is no node_modules here: dependencies are fetched from esm.sh and bundled by serve.${C.reset}\n`);
        return verb === 'help' ? 0 : 1;
    }
  },
};

export const npxCommand: Command = {
  name: 'npx',
  summary: 'npx vite / serve / http-server start the dev server',
  usage: 'npx vite | npx serve [dir] | npx http-server [dir]',
  async run(ctx) {
    const real = await realNode(ctx);
    if (real) return real(ctx, 'npx', ctx.args);
    const [tool, ...rest] = ctx.args;
    if (tool && /^(vite|serve|http-server|live-server)(@.*)?$/.test(tool)) {
      await startServer(ctx, ctx.path(rest.find((a) => !a.startsWith('-')) ?? '.'), { open: true });
      return;
    }
    throw new Error(`npx ${tool ?? ''}: only dev servers are available here (npx vite, npx serve). Packages for your app go in package.json (npm install <pkg>).`);
  },
};
