import { contributedNames, findContributed } from '../contrib';
import { listApps } from '../../kernel/apps';
import { fmtBytes, fmtDuration } from '../../kernel/format';
import type { Command } from '../shell';
import { C } from '../ansi';
import { localCommandNames } from '../runners';

/** `help`'s sections, in order, and the built-in commands each lists. Others say their own (`Command.section`). */
const SECTIONS: Array<{ id: string; title: string; about: string; names: string[] }> = [
  { id: 'files', title: 'Files', about: 'look at, change and find files', names: ['ls', 'cd', 'pwd', 'tree', 'cat', 'head', 'tail', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'stat', 'find', 'du', 'df', 'mount', 'open'] },
  { id: 'text', title: 'Text and data', about: 'filter and transform text', names: ['echo', 'grep', 'sort', 'uniq', 'wc', 'tee', 'sha256sum', 'gzip', 'gunzip', 'zip', 'unzip', 'sqlite3'] },
  { id: 'code', title: 'Running code', about: 'programs in sandboxes', names: ['js', 'python', 'python3', 'pip', 'pip3', 'wasm', 'gpu'] },
  { id: 'web', title: 'Web projects', about: 'build, serve and ship', names: ['serve', 'build', 'esbuild', 'npm', 'npx', 'git', 'gh', 'deploy', 'curl'] },
  { id: 'ai', title: 'The agent', about: 'chats, projects and the agent itself', names: ['agent', 'setup'] },
  { id: 'packages', title: 'Packages', about: 'more software; installed commands are listed here too', names: ['pkg'] },
  { id: 'devices', title: 'Devices', about: 'hardware connected to this computer', names: ['serial'] },
  { id: 'you', title: 'You and BrowserBox', about: 'profiles, look and feel', names: ['profile', 'passwd', 'signout', 'logout', 'whoami'] },
  { id: 'system', title: 'System', about: 'processes, environment and the shell', names: ['ps', 'kill', 'sysinfo', 'uptime', 'uname', 'date', 'env', 'export', 'which', 'hash', 'history', 'sleep', 'notify', 'dmesg', 'clear', 'exit', 'true', 'false', 'help'] },
];
const sectionOf = (c: Command): string => c.section ?? SECTIONS.find((s) => s.names.includes(c.name))?.id ?? 'system';

/** The commands under one heading: name, then what it does, wrapped to the terminal's width. */
function block(out: (t: string) => void, title: string, about: string, rows: Array<[string, string]>): void {
  if (!rows.length) return;
  out(`\n${C.bold}${title}${C.reset} ${C.dim}— ${about}${C.reset}\n`);
  const width = Math.max(10, ...rows.map(([n]) => n.length + 2));
  // Wrapped under the description (the terminal's width is not known: 64 columns fits a side panel).
  const room = Math.max(24, 64 - 2 - width);
  for (const [name, summary] of rows) {
    const lines: string[] = [];
    let line = '';
    for (const word of summary.split(' ')) {
      const visible = (line + ' ' + word).replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (line && visible.length > room) (lines.push(line), (line = word));
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    out(`  ${C.cyan}${name.padEnd(width)}${C.reset}${lines.join(`\n  ${' '.repeat(width)}`)}\n`);
  }
}

export const sysCommands: Command[] = [
  {
    name: 'help',
    summary: 'list commands by section; help <command> for one, help <section> for a section',
    usage: 'help [command | section]',
    async run({ args, shell, out, os }) {
      const all = new Map<string, Command>([...contributedNames().map((n) => [n, findContributed(n)!] as const), ...shell.commands]);
      const want = args[0];
      const one = want ? all.get(want) : undefined;
      if (one) {
        out(`${C.bold}${one.name}${C.reset} — ${one.summary}\n`);
        if (one.usage) out(`${C.dim}usage:${C.reset} ${one.usage.replace(/\n\s*/g, '\n       ')}\n`);
        return;
      }
      const section = want ? SECTIONS.find((s) => s.id === want || s.title.toLowerCase() === want.toLowerCase()) : undefined;
      // Commands from installed packages and from ~/.local/bin are commands too.
      const external = os.packages.externalCommands();
      const local = await localCommandNames(os).catch(() => [] as string[]);
      if (want && !section && !external.includes(want) && !local.includes(want)) throw new Error(`no such command or section: ${want} (help lists them)`);
      if (want && !section) return void out(`${C.bold}${want}${C.reset} — ${external.includes(want) ? `from an installed package (pkg info, or ${want} --help)` : `your command in ~/.local/bin`}\n`);
      if (!section) {
        out(`${C.bold}BrowserBox shell${C.reset}\n`);
        out(`  pipes ${C.cyan}|${C.reset}, redirects ${C.cyan}> >> <${C.reset}, ${C.cyan}&& || ;${C.reset}, ${C.cyan}$VARS${C.reset}, wildcards, quotes, history (↑), Tab completion. Not bash: no loops, functions or $(…).\n`);
      }
      for (const s of SECTIONS) {
        if (section && s !== section) continue;
        const rows = [...all.values()]
          .filter((c) => sectionOf(c) === s.id)
          .sort((a, b) => (s.names.indexOf(a.name) + 1 || 999) - (s.names.indexOf(b.name) + 1 || 999) || a.name.localeCompare(b.name))
          .map((c) => [c.name, c.summary] as [string, string]);
        if (s.id === 'packages') for (const name of external.filter((n) => !all.has(n)).sort()) rows.push([name, `${C.dim}from an installed package${C.reset}`]);
        block(out, s.title, s.about, rows);
      }
      if (!section || section.id === 'packages') block(out, 'Your commands', '~/.local/bin', local.sort().map((n) => [n, `${C.dim}~/.local/bin/${n}${C.reset}`]));
      if (!section) out(`\n${C.dim}help <command> for its usage · help <section> (${SECTIONS.map((s) => s.id).join(', ')}) for one section${C.reset}\n`);
    },
  },
  {
    name: 'ps',
    summary: 'list processes',
    async run({ os, out }) {
      out(`${C.dim}${'PID'.padStart(4)} ${'PPID'.padStart(4)}  ${'KIND'.padEnd(8)} ${'STATE'.padEnd(8)} ${'CPU'.padStart(8)}  NAME${C.reset}\n`);
      for (const p of os.procs.list()) {
        out(`${String(p.pid).padStart(4)} ${String(p.ppid).padStart(4)}  ${p.kind.padEnd(8)} ${p.state.padEnd(8)} ${fmtDuration(p.cpuMs).padStart(8)}  ${p.name}${p.detail ? ` ${C.dim}${p.detail}${C.reset}` : ''}\n`);
      }
    },
  },
  {
    name: 'kill',
    summary: 'terminate a process',
    usage: 'kill pid…',
    async run({ args, os, err }) {
      if (!args.length) throw new Error('usage: kill pid…');
      let code = 0;
      for (const a of args) {
        if (!os.procs.kill(Number(a))) {
          err(`kill: ${a}: no such process\n`);
          code = 1;
        }
      }
      return code;
    },
  },
  {
    name: 'open',
    summary: 'open an app, or a file in the right app',
    usage: 'open <app | path>',
    async run({ args, os, path, out }) {
      const target = args[0];
      if (!target) return void out(`apps: ${listApps().filter((a) => !a.hidden).map((a) => a.id).join(', ')}\n`);
      if (listApps().some((a) => a.id === target)) return void os.openApp(target, args[1] ? { path: path(args[1]) } : {});
      const p = path(target);
      const st = await os.fs.stat(p);
      if (!st) throw new Error(`${target}: no such app or file`);
      if (st.kind === 'dir') os.openApp('files', { path: p });
      else if (/\.(html?|png|jpe?g|gif|webp|svg|avif|pdf|mp3|wav|ogg|mp4|webm)$/i.test(p)) os.openApp('preview', { path: p });
      else os.openApp('editor', { path: p });
    },
  },
  {
    name: 'env',
    summary: 'print environment variables',
    async run({ shell, out }) {
      for (const [k, v] of Object.entries(shell.env)) if (k !== '?') out(`${k}=${v}\n`);
    },
  },
  {
    name: 'export',
    summary: 'set an environment variable',
    usage: 'export NAME=value',
    async run({ args, shell }) {
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq < 1) throw new Error('usage: export NAME=value');
        shell.env[a.slice(0, eq)] = a.slice(eq + 1);
      }
    },
  },
  {
    name: 'clear',
    summary: 'clear the terminal',
    async run({ shell }) {
      shell.tty?.clear();
    },
  },
  {
    name: 'history',
    summary: 'show command history',
    async run({ shell, out }) {
      shell.history.forEach((l, i) => out(`${String(i + 1).padStart(4)}  ${l}\n`));
    },
  },
  {
    name: 'date',
    summary: 'print the date and time',
    async run({ out }) {
      out(new Date().toString() + '\n');
    },
  },
  {
    name: 'whoami',
    summary: 'print the user name',
    async run({ shell, out }) {
      out((shell.env.USER ?? 'user') + '\n');
    },
  },
  {
    name: 'uname',
    summary: 'print system information',
    async run({ os, out, args }) {
      out(args.includes('-a') ? `BrowserBox ${os.version} wasm32 ${navigator.userAgent}\n` : 'BrowserBox\n');
    },
  },
  {
    name: 'uptime',
    summary: 'time since boot',
    async run({ os, out }) {
      out(`up ${fmtDuration(performance.now())}, ${os.procs.list().length} processes\n`);
    },
  },
  {
    name: 'sysinfo',
    summary: 'platform capabilities and boot timings',
    async run({ os, out }) {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      out(`${C.bold}BrowserBox ${os.version}${C.reset}\n`);
      out(`root fs   ${os.rootKind === 'opfs' ? 'OPFS (persistent)' : 'memory (not persistent)'}\n`);
      out(`storage   ${fmtBytes(est?.usage ?? NaN)} / ${fmtBytes(est?.quota ?? NaN)}\n`);
      out(`cores     ${navigator.hardwareConcurrency ?? '?'}\n`);
      out(`boot      ${os.bootMarks.map((m) => `${m.name} ${m.at}ms`).join(' → ')}\n\n`);
      for (const c of os.caps) out(`${c.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${c.label.padEnd(26)} ${C.dim}${c.use}${C.reset}\n`);
    },
  },
  {
    name: 'sleep',
    summary: 'wait N seconds',
    usage: 'sleep seconds',
    async run({ args, signal }) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, (Number(args[0]) || 0) * 1000);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      });
    },
  },
  {
    name: 'notify',
    summary: 'show a notification',
    usage: 'notify title [body]',
    async run({ args, os }) {
      os.notify({ title: args[0] ?? 'Notification', body: args.slice(1).join(' ') || undefined });
    },
  },
  {
    name: 'which',
    summary: 'locate a command',
    async run({ args, shell, out }) {
      let code = 0;
      for (const a of args) {
        if (shell.commands.has(a)) out(`/bin/${a}\n`);
        else code = 1;
      }
      return code;
    },
  },
  { name: 'true', summary: 'succeed', run: async () => 0 },
  { name: 'false', summary: 'fail', run: async () => 1 },
];
