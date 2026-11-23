import { contributedNames, findContributed } from '../contrib';
import { listApps } from '../../kernel/apps';
import { fmtBytes, fmtDuration } from '../../kernel/format';
import type { Command } from '../shell';
import { C } from '../ansi';

export const sysCommands: Command[] = [
  {
    name: 'help',
    summary: 'list commands',
    usage: 'help [command]',
    async run({ args, shell, out }) {
      const one = args[0] ? (shell.commands.get(args[0]) ?? findContributed(args[0])) : undefined;
      if (args[0] && !one) throw new Error(`no such command: ${args[0]}`);
      if (one) return void out(`${C.bold}${one.name}${C.reset} — ${one.summary}\n${one.usage ? `usage: ${one.usage}\n` : ''}`);
      out(`${C.bold}BrowserBox shell${C.reset} — pipes (|), redirects (> >> <), && || ;, $VARS, globs, quotes.\n\n`);
      const all = new Map([...contributedNames().map((n) => [n, findContributed(n)!] as const), ...shell.commands]);
      for (const c of [...all.values()].sort((a, b) => a.name.localeCompare(b.name))) out(`  ${C.cyan}${c.name.padEnd(10)}${C.reset} ${c.summary}\n`);
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
