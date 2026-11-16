import { APPS } from '@/ui/apps';
import { fmtBytes } from '@/ui/dom';
import { clip, obj, tool, type ToolDef } from './types';

/** Reduces an HTML document to readable text so pages fit in context. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, svg, iframe, template').forEach((n) => n.remove());
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')!;
    if (/^https?:/.test(href) && a.textContent?.trim()) a.textContent = `${a.textContent.trim()} (${href})`;
  });
  doc.querySelectorAll('p, div, br, li, tr, h1, h2, h3, h4, h5, h6, section, article').forEach((n) => n.append('\n'));
  const title = doc.title ? `# ${doc.title}\n\n` : '';
  return title + (doc.body?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
}

export const systemTools: ToolDef[] = [
  tool<{ url: string; method?: string; headers?: Record<string, string>; body?: string; raw?: boolean; save_to?: string }>({
    name: 'http_fetch',
    description:
      'Make an HTTP request from the browser. Only works for servers that allow cross-origin requests (CORS) — many public APIs do, most ordinary web pages do not. HTML is converted to readable text unless raw is true. Use save_to to store the response body as a file (binary-safe).',
    input_schema: obj(
      { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, raw: { type: 'boolean' }, save_to: { type: 'string', description: 'path to save the body to' } },
      ['url'],
    ),
    cap: () => 'net',
    describe: (i) => `${i.method ?? 'GET'} ${i.url}`,
    async run(i, tc) {
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
        return `${head}Saved ${fmtBytes(data.length)} to ${tc.path(i.save_to)}`;
      }
      const text = await res.text();
      return head + clip(type.includes('html') && !i.raw ? htmlToText(text) : text);
    },
  }),
  tool<{ app: string; path?: string; url?: string }>({
    name: 'open_app',
    description: `Open an application window for the user. Apps: ${APPS.filter((a) => !a.hidden).map((a) => a.id).join(', ')}. Pass path to open a file or folder (files, editor, preview) or url for the browser.`,
    input_schema: obj({ app: { type: 'string', enum: APPS.map((a) => a.id) }, path: { type: 'string' }, url: { type: 'string' } }, ['app']),
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
    description: 'List running processes (apps, agents, sandboxes, services) with pid, state and CPU time.',
    input_schema: obj({}),
    cap: () => null,
    describe: () => 'List processes',
    async run(_i, tc) {
      return tc.os.procs.list().map((p) => `${p.pid}\tppid ${p.ppid}\t${p.kind}\t${p.state}\t${Math.round(p.cpuMs)}ms\t${p.name}\t${p.detail}`).join('\n');
    },
  }),
  tool<{ pid: number }>({
    name: 'kill_process',
    description: 'Terminate a process by pid.',
    input_schema: obj({ pid: { type: 'integer' } }, ['pid']),
    cap: () => 'system',
    describe: (i) => `Kill process ${i.pid}`,
    async run(i, tc) {
      if (i.pid === tc.pid) throw new Error('refusing to kill the agent itself');
      if (!tc.os.procs.kill(i.pid)) throw new Error(`no such process: ${i.pid}`);
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
    description: 'Show the user a notification (in the OS, and as a system notification when the tab is in the background and permission was granted).',
    input_schema: obj({ title: { type: 'string' }, body: { type: 'string' } }, ['title']),
    cap: () => null,
    describe: (i) => `Notify: ${i.title}`,
    async run(i, tc) {
      tc.os.notify({ title: i.title, body: i.body });
      if (document.hidden && globalThis.Notification?.permission === 'granted') new Notification(i.title, { body: i.body });
      return 'Notification shown.';
    },
  }),
  tool<{ text: string }>({
    name: 'clipboard_write',
    description: "Copy text to the user's clipboard.",
    input_schema: obj({ text: { type: 'string' } }, ['text']),
    cap: () => 'clipboard',
    describe: (i) => `Copy ${i.text.length} characters to the clipboard`,
    async run(i) {
      await navigator.clipboard.writeText(i.text);
      return 'Copied.';
    },
  }),
  tool<Record<string, never>>({
    name: 'clipboard_read',
    description: "Read text from the user's clipboard.",
    input_schema: obj({}),
    cap: () => 'clipboard',
    describe: () => 'Read the clipboard',
    async run() {
      return clip(await navigator.clipboard.readText()) || '(clipboard is empty)';
    },
  }),
  tool<{ text: string }>({
    name: 'speak',
    description: 'Read text aloud with speech synthesis.',
    input_schema: obj({ text: { type: 'string' } }, ['text']),
    cap: () => 'system',
    describe: (i) => `Speak: ${i.text.slice(0, 80)}`,
    async run(i) {
      if (!('speechSynthesis' in globalThis)) throw new Error('speech synthesis is not available in this browser');
      speechSynthesis.speak(new SpeechSynthesisUtterance(i.text.slice(0, 2000)));
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
  tool<{ task: string }>({
    name: 'spawn_agent',
    description:
      'Delegate a self-contained task to a sub-agent with its own fresh context and the same tools. It starts with no knowledge of this conversation, so give it everything it needs. Returns its final report. Useful for keeping long explorations out of your own context.',
    input_schema: obj({ task: { type: 'string' } }, ['task']),
    cap: () => null,
    describe: (i) => `Sub-agent: ${i.task.slice(0, 120)}`,
    run: (i, tc) => tc.spawnAgent(i.task),
  }),
];
