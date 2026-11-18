import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { heading } from './nav';

export const ENV_KEY = 'env.vars';
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['HOME', 'USER', 'SHELL', 'PATH', 'AGENT_HOME']);

/** Environment variables passed to every shell, run_js (`env`) and Python (`os.environ`). */
export function environmentSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const read = () => os.settings.get<Record<string, string>>(ENV_KEY, {});
  const rows = h('div', { class: 'env-rows' });
  const error = h('p', { class: 'st-error', hidden: true });

  function save(): void {
    const next: Record<string, string> = {};
    const problems: string[] = [];
    for (const r of rows.querySelectorAll<HTMLElement>('.env-row')) {
      const [k, v] = [...r.querySelectorAll('input')].map((i) => i.value);
      const key = k!.trim();
      if (!key && !v) continue;
      if (!NAME.test(key)) problems.push(`“${key || '(empty)'}” is not a valid name`);
      else if (RESERVED.has(key)) problems.push(`${key} is set by BrowserBox`);
      else next[key] = v!;
    }
    error.hidden = !problems.length;
    error.textContent = problems.join('; ');
    if (problems.length) return;
    os.settings.set(ENV_KEY, next);
    saved();
  }

  function row(key = '', value = ''): HTMLElement {
    const r = h(
      'div',
      { class: 'env-row' },
      h('input', { class: 'input mono', value: key, placeholder: 'NAME', 'aria-label': 'Variable name', autocomplete: 'off', spellcheck: false, onchange: save }),
      h('input', { class: 'input mono', value, placeholder: 'value', 'aria-label': `Value of ${key || 'variable'}`, autocomplete: 'off', spellcheck: false, onchange: save }),
      h(
        'button',
        {
          class: 'btn small ghost',
          type: 'button',
          'aria-label': `Remove ${key || 'variable'}`,
          onclick: () => {
            r.remove();
            save();
          },
        },
        'Remove',
      ),
    );
    return r;
  }

  rows.append(...Object.entries(read()).map(([k, v]) => row(k, v)));
  return h(
    'div',
    { class: 'st-section' },
    heading('Environment', '$NAME in the shell, env.NAME in run_js, os.environ in Python.'),
    h('p', { class: 'st-note muted' }, 'Not encrypted, and readable by the agent. Keep keys in Model or Connectors.'),
    rows,
    error,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => rows.append(row()) }, 'Add variable')),
    isolationBlock(),
  );
}

/**
 * Cross-origin isolation: SharedArrayBuffer, WebAssembly threads and Node.js
 * in the browser (the node package) need it. The service worker adds the
 * headers, so it applies from the next load.
 */
/** Read by the service worker (public/sw.js): the same absolute key everywhere. */
const COI_KEY = 'https://flags.browserbox.local/coi';

function isolationBlock(): HTMLElement {
  const on = globalThis.crossOriginIsolated === true;
  const status = h('span', { class: `badge ${on ? 'ok' : ''}` }, on ? 'On' : 'Off');
  const box = h('input', { type: 'checkbox', id: 'st-coi' }) as HTMLInputElement;
  const note = h('p', { class: 'st-note', hidden: true });
  const reload = h('button', { class: 'btn primary', type: 'button', hidden: true, onclick: () => (window.top ?? window).location.reload() }, 'Reload to apply');
  void caches?.open('bbx-flags').then((c) => c.match(COI_KEY)).then((r) => (box.checked = !!r), () => undefined);
  box.addEventListener('change', async () => {
    const c = await caches.open('bbx-flags');
    if (box.checked) await c.put(COI_KEY, new Response('1'));
    else await c.delete(COI_KEY);
    const pending = box.checked !== on;
    reload.hidden = !pending;
    note.hidden = !pending;
    note.textContent = pending ? 'Reload every BrowserBox window (agent and desktop) for this to take effect.' : '';
  });
  return h(
    'div',
    { class: 'st-panel' },
    h('h3', null, 'Cross-origin isolation ', status),
    h('p', { class: 'muted st-note' }, 'Turns on SharedArrayBuffer and WebAssembly threads, which the node package (real Node.js and npm in the browser) needs. With it on, websites that do not allow it can no longer be shown inside the Browser app, and pop-up windows lose their link to this one.'),
    h('label', { class: 'row', for: 'st-coi' }, box, h('span', null, 'Isolate BrowserBox (SharedArrayBuffer)')),
    note,
    reload,
  );
}
