import type { DevInfo, DevLog, WireRequest } from '@/kernel/dev/types';
import { isInside } from '@/kernel/vfs/path';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
import { icon, loader } from '@/ui/icons';
import { htmlFrame } from './views';

const MAX_SHOWN = 300;

/**
 * Preview's dev-server mode: shows the app a dev server builds, forwards the
 * page's requests and console output to the server, reloads when project
 * files change, and keeps a console the person (and the agent) can read.
 */
export function mountDev(ctx: AppContext, port: number): () => void {
  const { os } = ctx;
  let path = typeof ctx.args.path === 'string' && ctx.args.path.startsWith('/') ? ctx.args.path : '/';
  let info: DevInfo | null = null;
  let frame: HTMLIFrameElement | null = null;
  let gen = 0;
  let errors = 0;
  let closed = false;

  // ---- chrome -------------------------------------------------------------------
  const address = h('input', { class: 'pv-addr-input', type: 'text', spellcheck: false, autocomplete: 'off', 'aria-label': 'Address', value: path });
  const go = () => {
    const v = address.value.trim().replace(/^(https?:\/\/)?localhost(:\d+)?/, '') || '/';
    path = v.startsWith('/') ? v : `/${v}`;
    void load();
  };
  address.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
  const tb = (label: string, child: Node, onclick: () => void, extra: Record<string, unknown> = {}) => h('button', { class: 'btn small ghost pv-icon-btn', type: 'button', title: label, 'aria-label': label, onclick, ...extra }, child);
  const badge = h('span', { class: 'pv-badge', hidden: true });
  const consoleBtn = tb('Console', h('span', { class: 'pv-console-label' }, icon('terminal', 15), badge), () => setConsole(consolePane.hidden !== false), { 'aria-pressed': 'false' });
  const status = h('span', { class: 'pv-status', hidden: true }, loader(16, 'Building'));
  const addr = h('label', { class: 'pv-addr' }, h('span', { class: 'pv-host' }, `localhost:${port}`), address);
  const toolbar = h('div', { class: 'toolbar pv-toolbar pv-dev-toolbar', role: 'toolbar', 'aria-label': 'Preview' }, tb('Reload', icon('refresh', 15), () => void load()), addr, status, consoleBtn);

  const list = h('div', { class: 'pv-log', role: 'log', 'aria-live': 'polite' });
  const consolePane = h(
    'section',
    { class: 'pv-console', hidden: true, 'aria-label': 'Console' },
    h('div', { class: 'pv-console-head' }, h('strong', null, 'Console'), h('span', { class: 'muted pv-console-note' }, 'page, server, build and network'), tb('Clear', icon('close', 14), () => clearLog())),
    list,
  );
  const stage = h('div', { class: 'pv-stage' });
  const body = h('div', { class: 'pv-body fill pv-dev' }, stage, consolePane);
  ctx.root.append(toolbar, body);

  function setConsole(open: boolean): void {
    consolePane.hidden = !open;
    consoleBtn.setAttribute('aria-pressed', String(open));
    if (open) list.scrollTop = list.scrollHeight;
  }
  function clearLog(): void {
    list.replaceChildren();
    errors = 0;
    badge.hidden = true;
  }
  function addLog(l: DevLog): void {
    const row = h('div', { class: `pv-log-row ${l.level}` }, h('span', { class: 'pv-log-src' }, l.source), h('span', { class: 'pv-log-text' }, l.text));
    const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 8;
    list.append(row);
    while (list.childElementCount > MAX_SHOWN) list.firstElementChild?.remove();
    if (stick) list.scrollTop = list.scrollHeight;
    if (l.level === 'error') {
      errors++;
      badge.textContent = String(errors);
      badge.hidden = false;
    }
  }

  // ---- the page -------------------------------------------------------------------
  function onFrame(data: { type?: string } & Record<string, unknown>, reply: (m: unknown, t?: Transferable[]) => void): void {
    if (data.type === 'bbx-dev:req') {
      const id = data.id;
      void os.dev.request(port, data.req as WireRequest).then(
        (res) => reply({ type: 'bbx-dev:res', id, res }, res.body ? [res.body.buffer] : []),
        (err: Error) => reply({ type: 'bbx-dev:res', id, error: err.message }),
      );
    } else if (data.type === 'bbx-dev:log') {
      os.dev.log(port, [data.entry as Pick<DevLog, 'level' | 'source' | 'text'>]);
    } else if (data.type === 'bbx-dev:nav') {
      path = String(data.path || '/');
      void load();
    } else if (data.type === 'bbx-dev:path') {
      path = String(data.path || '/');
      if (document.activeElement !== address) address.value = path;
    }
  }

  async function load(): Promise<void> {
    const g = ++gen;
    address.value = path;
    status.hidden = false;
    if (!stage.firstChild) stage.append(h('div', { class: 'app-loading' }, loader(28, 'Building')));
    try {
      const page = await os.dev.page(port, path);
      if (g !== gen || closed) return;
      frame = htmlFrame(page.html, `localhost:${port}${path}`, onFrame);
      stage.replaceChildren(frame);
      ctx.win.setTitle(`localhost:${port}`);
    } catch (err) {
      if (g !== gen || closed) return;
      frame = null;
      stage.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'col', style: 'align-items:center' }, h('p', null, (err as Error).message), h('button', { class: 'btn small', type: 'button', onclick: () => void restart() }, 'Start it again'))));
    } finally {
      if (g === gen) status.hidden = true;
    }
  }

  async function restart(): Promise<void> {
    if (!info) return;
    const next = await os.dev.start({ root: info.root, port: info.port, network: info.network });
    info = next;
    void load();
  }

  // Live reload: any change in the project folder rebuilds the page.
  const reload = debounce(() => void load(), 250);
  ctx.on('fs:change', (c) => {
    if (info && c.type !== 'mount' && isInside(info.root, c.path) && !/\/(node_modules|dist|\.git)\//.test(c.path)) reload();
  });
  ctx.on('dev:log', ({ port: p, entry }) => p === port && addLog(entry));
  ctx.on('dev:update', (servers) => {
    const mine = servers.find((s) => s.port === port);
    if (mine) info = mine;
    else if (info) {
      gen++;
      frame = null;
      stage.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'col', style: 'align-items:center' }, h('p', null, `The server on :${port} stopped.`), h('button', { class: 'btn small', type: 'button', onclick: () => void restart() }, 'Start it again'))));
    }
  });

  void (async () => {
    info = (await os.dev.list()).find((s) => s.port === port) ?? null;
    for (const l of await os.dev.logs(port).catch(() => [])) addLog(l);
    if (!info) {
      stage.replaceChildren(h('div', { class: 'empty' }, h('p', null, `Nothing is being served on :${port}. Start a server with: serve <folder>`)));
      return;
    }
    await load();
  })();

  return () => {
    closed = true;
    gen++;
  };
}
