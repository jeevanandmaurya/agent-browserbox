import { listApps } from '../host/os.js';
import { fmtBytes } from '../host/format.js';
import { loadExtensions } from '../ext/library.js';
import { clip, obj, tool, type ToolContext, type ToolDef } from './types.js';
import { writeCap } from './fs.js';
import { AGENT_HOME } from '../host/paths.js';

/** Clipboard and speech exist only in windows, so the kernel borrows one. */
function ui(tc: ToolContext) {
  if (!tc.os.ui) throw new Error('no window is connected to do this');
  return tc.os.ui;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Reduces an HTML document to readable text so pages fit in context. (No DOM: this runs in the kernel worker.) */
function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*\bhref="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label} (${href})`)
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
  return (title ? `# ${title}\n\n` : '') + text;
}

export const systemTools: ToolDef[] = [
  tool<{ url: string; method?: string; headers?: Record<string, string>; body?: string; raw?: boolean; save_to?: string }>({
    name: 'http_fetch',
    description:
      'Make an HTTP request from the browser. Only works for servers that allow cross-origin requests (CORS) — many public APIs do, most ordinary web pages do not. HTML is converted to readable text unless raw is true. Use save_to to store the response body as a file (binary-safe) in your working folder or /tmp; move it elsewhere with move_path.',
    input_schema: obj(
      { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, raw: { type: 'boolean' }, save_to: { type: 'string', description: 'path to save the body to' } },
      ['url'],
    ),
    cap: () => 'net',
    describe: (i) => `${i.method ?? 'GET'} ${i.url}${i.save_to ? ` → ${i.save_to}` : ''}`,
    async run(i, tc) {
      // Network permission is not permission to write anywhere: downloads land in the workspace or /tmp.
      if (i.save_to && writeCap([i.save_to], tc) !== null) throw new Error(`save_to must be inside ${AGENT_HOME} or /tmp. Save it there, then move it with move_path (which asks the user).`);
      const url = new URL(i.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('only http and https URLs are supported');
      let res: Response;
      try {
        res = await fetch(url, { method: i.method ?? 'GET', headers: i.headers, body: i.body, signal: tc.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      } catch (err) {
        if (tc.signal.aborted) throw err;
        throw new Error(`Request to ${url.host} failed. The server is unreachable or does not send CORS headers, so a browser cannot read it. Try an API endpoint that supports CORS.`);
      }
      const type = res.headers.get('content-type') ?? '';
      const head = `HTTP ${res.status} ${res.statusText}\ncontent-type: ${type}\n\n`;
      if (i.save_to) {
        const data = new Uint8Array(await res.arrayBuffer());
        await tc.os.fs.writeFile(tc.path(i.save_to), data);
        await tc.seen.note(tc.path(i.save_to), data);
        return `${head}Saved ${fmtBytes(data.length)} to ${tc.path(i.save_to)}`;
      }
      const text = await res.text();
      return head + clip(type.includes('html') && !i.raw ? htmlToText(text) : text);
    },
  }),
  tool<{ app: string; path?: string; url?: string }>({
    name: 'open_app',
    // Getters: the apps are registered by the frontend after this module loads.
    get description() {
      return `Open an application window for the user. Apps: ${listApps().filter((a) => !a.hidden).map((a) => a.id).join(', ')}. Pass path to open a file or folder (files, editor, preview) or url for the browser.`;
    },
    get input_schema() {
      return obj({ app: { type: 'string', enum: listApps().map((a) => a.id) }, path: { type: 'string' }, url: { type: 'string' } }, ['app']);
    },
    cap: () => null,
    describe: (i) => `Open ${i.app}${i.path ? ` ${i.path}` : ''}`,
    async run(i, tc) {
      tc.os.openApp(i.app, { ...(i.path ? { path: tc.path(i.path) } : {}), ...(i.url ? { url: i.url } : {}) });
      return `Opened ${i.app}.`;
    },
  }),
  tool<{ html?: string; path?: string; title?: string }>({
    name: 'show_html',
    description:
      'Show the user a rendered HTML page in a Preview window — use it to present charts, reports, small apps or visualisations. Pass either html (a complete document; inline CSS/JS is fine, it runs sandboxed) or path to an .html file whose relative assets are resolved from the filesystem.',
    input_schema: obj({ html: { type: 'string' }, path: { type: 'string' }, title: { type: 'string' } }),
    cap: () => null,
    describe: (i) => `Show ${i.title ?? i.path ?? 'HTML preview'}`,
    async run(i, tc) {
      if (!i.html && !i.path) throw new Error('pass html or path');
      tc.os.openApp('preview', i.path ? { path: tc.path(i.path), title: i.title } : { html: i.html, title: i.title ?? 'Preview' });
      return 'The preview window is open.';
    },
  }),
  tool<Record<string, never>>({
    name: 'list_processes',
    description: "List the box's running processes (shells, sandboxes, dev servers, services) with pid, state and CPU time.",
    input_schema: obj({}),
    cap: () => null,
    describe: () => 'List processes',
    async run(_i, tc) {
      return (await tc.os.processes()).map((p) => `${p.pid}\tppid ${p.ppid ?? 0}\t${p.kind}\t${p.state}\t${Math.round(p.cpuMs)}ms\t${p.name}\t${p.detail}`).join('\n');
    },
  }),
  tool<{ pid: number }>({
    name: 'kill_process',
    description: "Terminate one of the box's processes by pid (see list_processes).",
    input_schema: obj({ pid: { type: 'integer' } }, ['pid']),
    cap: () => 'system',
    describe: (i) => `Kill process ${i.pid}`,
    async run(i, tc) {
      if (!(await tc.os.killProcess(i.pid))) throw new Error(`no such process: ${i.pid}`);
      return `Killed ${i.pid}.`;
    },
  }),
  tool<Record<string, never>>({
    name: 'system_info',
    description: 'Describe the environment: which browser APIs are available (WebGPU, OPFS, …), storage quota, mounts, cores and memory.',
    input_schema: obj({}),
    cap: () => null,
    describe: () => 'System info',
    async run(_i, tc) {
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      return [
        `BrowserBox ${tc.os.version}; root filesystem: ${tc.os.rootKind === 'opfs' ? 'OPFS (persistent)' : 'memory (lost on reload)'}`,
        `storage: ${fmtBytes(est?.usage ?? NaN)} used of ${fmtBytes(est?.quota ?? NaN)}; cores: ${navigator.hardwareConcurrency}; online: ${navigator.onLine}`,
        `mounts: ${tc.os.fs.mounts().map((m) => `${m.point} (${m.fs.label})`).join(', ')}`,
        `available: ${tc.os.caps.filter((c) => c.ok).map((c) => c.label).join(', ')}`,
        `unavailable: ${tc.os.caps.filter((c) => !c.ok).map((c) => c.label).join(', ') || 'none'}`,
      ].join('\n');
    },
  }),
  tool<{ title: string; body?: string }>({
    name: 'notify',
    description: 'Show the user a notification in every open BrowserBox window.',
    input_schema: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['title']),
    cap: () => null,
    describe: (i) => `Notify: ${i.title}`,
    async run(i, tc) {
      tc.os.notify({ title: i.title, body: i.body });
      return 'Notification shown.';
    },
  }),
  tool<{ text: string }>({
    name: 'clipboard_write',
    description: "Copy text to the user's clipboard.",
    input_schema: obj({ text: { type: 'string' } }, ['text']),
    cap: () => 'clipboard',
    describe: (i) => `Copy ${i.text.length} characters to the clipboard`,
    async run(i, tc) {
      await ui(tc).call('clipboard.write', i.text);
      return 'Copied.';
    },
  }),
  tool<Record<string, never>>({
    name: 'clipboard_read',
    description: "Read text from the user's clipboard.",
    input_schema: obj({}),
    cap: () => 'clipboard',
    describe: () => 'Read the clipboard',
    async run(_i, tc) {
      return clip(await ui(tc).call<string>('clipboard.read')) || '(clipboard is empty)';
    },
  }),
  tool<{ text: string }>({
    name: 'speak',
    description: 'Read text aloud with speech synthesis.',
    input_schema: obj({ text: { type: 'string' } }, ['text']),
    cap: () => 'system',
    describe: (i) => `Speak: ${i.text.slice(0, 80)}`,
    async run(i, tc) {
      await ui(tc).call('speak', i.text.slice(0, 2000));
      return 'Speaking.';
    },
  }),
  tool<{ question: string; options?: string[] }>({
    name: 'ask_user',
    description: 'Ask the user a question and wait for their answer. Use it only when you are blocked on a decision that is genuinely theirs to make.',
    input_schema: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'suggested answers' } }, ['question']),
    cap: () => null,
    describe: (i) => i.question,
    run: (i, tc) => tc.ask(i.question, i.options),
  }),
  tool<{ items: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' }> }>({
    name: 'todo_write',
    description: 'Publish your task list so the user can follow progress on multi-step work. Send the full list each time; statuses are pending, in_progress or done.',
    input_schema: obj({ items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['text', 'status'] } } }, ['items']),
    cap: () => null,
    describe: (i) => `Update task list (${Array.isArray(i.items) ? i.items.length : 0} items)`,
    async run(i, tc) {
      const items = (Array.isArray(i.items) ? i.items : []).filter((t) => t && typeof t.text === 'string').map((t) => ({ text: t.text, status: (['pending', 'in_progress', 'done'] as const).includes(t.status) ? t.status : 'pending' }));
      tc.setTodos(items);
      return 'Task list updated.';
    },
  }),
  tool<{ name: string }>({
    name: 'use_skill',
    description: 'Load a skill: returns its instructions and lists the supporting files in its folder. Call this before starting a task that matches a skill listed in your system prompt, then follow the instructions.',
    input_schema: obj({ name: { type: 'string' } }, ['name']),
    cap: () => null,
    describe: (i) => `Use skill ${i.name}`,
    async run(i, tc) {
      const skills = (await loadExtensions(tc.os, 'skill')).filter((s) => s.enabled);
      const skill = skills.find((s) => s.name === i.name);
      if (!skill) throw new Error(`No skill named "${i.name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}`);
      const files: string[] = [];
      for await (const f of tc.os.fs.walk(skill.dir, { maxDepth: 4 })) if (f.kind === 'file' && f.path !== skill.path) files.push(f.path);
      return `# Skill: ${skill.name}\nFolder: ${skill.dir}\n\n${skill.body}${files.length ? `\n\nSupporting files:\n${files.map((f) => `- ${f}`).join('\n')}` : ''}`;
    },
  }),
  tool<{ task: string; agent?: string }>({
    name: 'spawn_agent',
    description:
      'Delegate a self-contained task to a sub-agent with its own fresh context and the same tools. It starts with no knowledge of this conversation, so give it everything it needs. Returns its final report. Useful for keeping long explorations out of your own context.',
    input_schema: obj({ task: { type: 'string' }, agent: { type: 'string', description: 'name of a custom agent listed in your system prompt; omit for a general-purpose sub-agent' } }, ['task']),
    cap: () => null,
    describe: (i) => `${i.agent ? `Agent ${i.agent}` : 'Sub-agent'}: ${i.task.slice(0, 120)}`,
    run: (i, tc) => tc.spawnAgent(i.task, i.agent),
  }),
];
