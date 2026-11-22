import type { DevLog } from '../host/os.js';
import { obj, tool } from './types.js';

const fmt = (l: DevLog) => `[${l.source}] ${l.level === 'log' ? '' : `${l.level}: `}${l.text}`;
/** What each session has already been shown, per port. */
const seen = new Map<string, number>();

/** Dev servers: the agent builds web apps and checks them like a developer with a browser console. */
export const devTools = [
  tool<{ action: 'start' | 'stop' | 'list'; path?: string; port?: number; network?: boolean }>({
    name: 'dev_server',
    description:
      'Run a web app you are building, like `npm run dev`. start serves a project folder at a virtual http://localhost:<port>/ and opens it in the Preview panel: index.html (or src/main.tsx/jsx/ts/js without one) with TypeScript, JSX, CSS modules and JSON bundled by esbuild; npm packages listed in package.json (or imported by name) load from esm.sh; files reload on save. Requests the page makes to its own address are answered from project files or by a backend: a server.ts/server.js that does `export default { fetch(request, env) { return new Response(...) } }` (env.fs reads and writes project files; env holds .env variables). Client-side routes get index.html. After starting or changing the app, call preview_logs to see console output, errors and failed requests.',
    input_schema: obj(
      {
        action: { type: 'string', enum: ['start', 'stop', 'list'] },
        path: { type: 'string', description: 'project folder (start); default: the working directory' },
        port: { type: 'number', description: 'start: a specific port; stop: which server' },
        network: { type: 'boolean', description: 'let the backend make outbound requests (default false)' },
      },
      ['action'],
    ),
    cap: (i) => (i.action === 'start' && i.network ? 'net' : null),
    describe: (i) => (i.action === 'start' ? `Serve ${i.path ?? '.'}` : i.action === 'stop' ? `Stop the dev server${i.port ? ` on :${i.port}` : ''}` : 'List dev servers'),
    async run(i, tc) {
      const dev = tc.os.dev;
      if (i.action === 'list') {
        const list = await dev.list();
        return list.length ? list.map((s) => `${s.url} → ${s.root}${s.backend ? ` (backend ${s.backend})` : ''}`).join('\n') : 'No dev servers are running.';
      }
      if (i.action === 'stop') {
        const list = await dev.list();
        const ports = i.port ? [i.port] : list.map((s) => s.port);
        for (const p of ports) await dev.stop(p);
        return ports.length ? `Stopped ${ports.map((p) => `:${p}`).join(', ')}.` : 'Nothing was running.';
      }
      const root = tc.path(i.path ?? '.');
      if (!tc.os.packages.isInstalled('esbuild')) {
        tc.progress('installing the esbuild package…\n');
        await tc.os.packages.install('esbuild');
      }
      const info = await dev.start({ root, port: i.port, network: i.network });
      tc.os.openApp('preview', { dev: info.port });
      // Give the page a moment to load so the first look at the logs is useful.
      await new Promise((r) => setTimeout(r, 1500));
      const logs = await dev.logs(info.port);
      seen.set(String(info.port), logs.at(-1)?.seq ?? 0);
      const problems = logs.filter((l) => l.level === 'error' || l.level === 'warn');
      return [
        `Serving ${info.root} at ${info.url} (virtual; it opens in the Preview panel, not in other tabs).`,
        info.backend ? `Backend: ${info.backend}${info.network ? ' (network allowed)' : ' (no network)'}.` : 'No backend (add server.ts to answer API requests).',
        problems.length ? `Problems so far:\n${problems.map(fmt).join('\n')}` : logs.length ? `Console so far:\n${logs.slice(-20).map(fmt).join('\n')}` : 'No console output yet.',
      ].join('\n');
    },
  }),
  tool<{ port?: number; wait_ms?: number; all?: boolean }>({
    name: 'preview_logs',
    description:
      "Read what the app on a dev server printed since you last looked: browser console output, uncaught errors, failed requests (404/500), build errors and the backend's console. Preview reloads by itself when files change, so after editing wait a moment (wait_ms) and read the logs to check your change worked.",
    input_schema: obj({
      port: { type: 'number', description: 'default: the only running server' },
      wait_ms: { type: 'number', description: 'wait this long first, for a reload to finish (default 1200, max 10000)' },
      all: { type: 'boolean', description: 'return everything kept (the last 500 entries), not only new ones' },
    }),
    cap: () => null,
    describe: (i) => `Read preview logs${i.port ? ` for :${i.port}` : ''}`,
    async run(i, tc) {
      const list = await tc.os.dev.list();
      const port = i.port ?? (list.length === 1 ? list[0]!.port : undefined);
      if (port === undefined) return list.length ? `Several servers are running (${list.map((s) => s.port).join(', ')}): pass port.` : 'No dev server is running. Start one with dev_server.';
      await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(0, i.wait_ms ?? 1200))));
      const key = String(port);
      const logs = await tc.os.dev.logs(port, { after: i.all ? 0 : (seen.get(key) ?? 0) });
      if (logs.length) seen.set(key, logs.at(-1)!.seq);
      if (!logs.length) return 'Nothing new. (Is the Preview panel showing this app? The page only runs while it is open.)';
      const errors = logs.filter((l) => l.level === 'error').length;
      return `${logs.length} entr${logs.length === 1 ? 'y' : 'ies'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}:\n${logs.slice(-200).map(fmt).join('\n')}`;
    },
  }),
];
