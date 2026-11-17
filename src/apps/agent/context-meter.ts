import type { ContextReport } from '@/agent/types';
import { h } from '@/ui/dom';

const PARTS: Array<{ key: keyof ContextReport['parts']; label: string; color: string }> = [
  { key: 'system', label: 'System prompt', color: 'var(--muted)' },
  { key: 'tools', label: 'Tool definitions', color: 'color-mix(in srgb, var(--muted) 55%, var(--panel-3))' },
  { key: 'user', label: 'Your messages', color: 'var(--accent)' },
  { key: 'assistant', label: 'Replies', color: 'color-mix(in srgb, var(--accent) 55%, var(--text))' },
  { key: 'toolCalls', label: 'Tool calls', color: 'var(--warn)' },
  { key: 'toolResults', label: 'Tool results', color: 'var(--ok)' },
];

/** Running totals for the session, and the speed of the last reply. */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  calls: number;
  /** Output tokens per second of the last model call. */
  tps: number;
  ttft: number;
  model: string;
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(Math.round(n)));
const NS = 'http://www.w3.org/2000/svg';

/**
 * How full the model's context window is, and what is taking the space.
 * The ring shows the total; the panel breaks it down and offers to compact.
 */
export function contextMeter(opts: { load(): Promise<ContextReport | null>; compact(): void }): { el: HTMLElement; refresh(): void; open(): void; usage(u: SessionUsage): void } {
  let session: SessionUsage | null = null;
  const ring = document.createElementNS(NS, 'svg');
  ring.setAttribute('viewBox', '0 0 20 20');
  ring.setAttribute('width', '18');
  ring.setAttribute('height', '18');
  ring.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'circle');
  const arc = document.createElementNS(NS, 'circle');
  for (const c of [track, arc]) {
    c.setAttribute('cx', '10');
    c.setAttribute('cy', '10');
    c.setAttribute('r', '7.5');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', '2.5');
    ring.append(c);
  }
  track.setAttribute('class', 'cm-track');
  arc.setAttribute('class', 'cm-arc');
  arc.setAttribute('transform', 'rotate(-90 10 10)');
  arc.setAttribute('stroke-dasharray', String(2 * Math.PI * 7.5));
  arc.setAttribute('stroke-linecap', 'round');

  const pct = h('span', { class: 'cm-pct' });
  const btn = h('button', { class: 'cm-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => (panel.hidden ? open() : close()) }, ring, pct);
  const panel = h('div', { class: 'popover cm-panel', role: 'dialog', 'aria-label': 'Context window', hidden: true });
  const el = h('div', { class: 'cm', hidden: true }, btn, panel);
  let last: ContextReport | null = null;

  function paint(r: ContextReport | null): void {
    last = r;
    el.hidden = !r || !r.window || (!r.messages && !r.used);
    if (!r || el.hidden) return;
    const frac = Math.min(1, r.used / r.window);
    arc.setAttribute('stroke-dashoffset', String(2 * Math.PI * 7.5 * (1 - frac)));
    el.dataset.level = frac >= (r.autoCompactAt || 0.85) * 0.94 ? 'high' : frac >= 0.6 ? 'mid' : 'low';
    pct.textContent = `${Math.round(frac * 100)}%`;
    btn.title = `Context: ${k(r.used)} of ${k(r.window)} tokens (${Math.round(frac * 100)}%)`;
    btn.setAttribute('aria-label', btn.title);
    if (!panel.hidden) renderPanel(r);
  }

  function renderPanel(r: ContextReport): void {
    const total = Object.values(r.parts).reduce((a, b) => a + b, 0) || 1;
    // The breakdown is estimated per block; scale it to the measured total when the model reported one.
    const scale = r.reported ? r.used / total : 1;
    const free = Math.max(0, r.window - r.used);
    const bar = h('div', { class: 'cm-bar', role: 'img', 'aria-label': `${Math.round((r.used / r.window) * 100)}% used` });
    for (const p of PARTS) {
      const w = (r.parts[p.key] * scale) / r.window;
      if (w > 0) bar.append(h('span', { style: `width:${Math.max(w * 100, 0.4)}%;background:${p.color}` }));
    }
    if (r.autoCompactAt) bar.append(h('i', { class: 'cm-mark', style: `left:${r.autoCompactAt * 100}%`, title: 'Auto-compact threshold' }));
    panel.replaceChildren(
      h('div', { class: 'cm-head' }, h('strong', null, 'Context window'), h('span', { class: 'muted' }, `${k(r.used)} / ${k(r.window)}`)),
      bar,
      h(
        'table',
        { class: 'cm-table' },
        h(
          'tbody',
          null,
          PARTS.map((p) => h('tr', null, h('td', null, h('span', { class: 'cm-dot', style: `background:${p.color}` }), p.label), h('td', null, k(r.parts[p.key] * scale)))),
          h('tr', { class: 'cm-free' }, h('td', null, h('span', { class: 'cm-dot' }), 'Free'), h('td', null, k(free))),
        ),
      ),
      h(
        'p',
        { class: 'cm-note' },
        r.reported ? 'Total as reported by the model on its last reply; the split is estimated.' : 'Estimated; the model reports exact figures after its next reply.',
        r.autoCompactAt ? ` The conversation is summarised automatically at ${Math.round(r.autoCompactAt * 100)}%.` : ' Automatic compaction is off (Settings → Model).',
        r.compactions ? ` Compacted ${r.compactions} time${r.compactions === 1 ? '' : 's'} so far.` : '',
      ),
      session
        ? h(
            'div',
            { class: 'cm-session' },
            h('strong', null, 'This session'),
            h(
              'table',
              { class: 'cm-table' },
              h(
                'tbody',
                null,
                h('tr', null, h('td', null, 'Model calls'), h('td', null, String(session.calls))),
                h('tr', null, h('td', null, 'Input tokens'), h('td', null, k(session.input))),
                session.cacheRead ? h('tr', null, h('td', null, 'Read from cache'), h('td', null, k(session.cacheRead))) : null,
                h('tr', null, h('td', null, 'Output tokens'), h('td', null, k(session.output))),
                session.tps ? h('tr', null, h('td', null, 'Last reply speed'), h('td', null, `${session.tps >= 100 ? Math.round(session.tps) : session.tps.toFixed(1)} tok/s`)) : null,
                h('tr', null, h('td', null, 'First token after'), h('td', null, `${(session.ttft / 1000).toFixed(1)} s`)),
              ),
            ),
          )
        : '',
      h(
        'div',
        { class: 'cm-actions' },
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            disabled: r.messages < 2,
            onclick: () => {
              close();
              opts.compact();
            },
          },
          'Compact now',
        ),
      ),
    );
  }

  const outside = (e: PointerEvent) => !el.contains(e.target as Node) && close();
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && (close(), btn.focus());
  function open(): void {
    if (!last) return;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    renderPanel(last);
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', esc, true);
  }
  function close(): void {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', esc, true);
  }

  return {
    el,
    usage(u) {
      session = u;
      if (!panel.hidden && last) renderPanel(last);
    },
    refresh: () => void opts.load().then(paint, () => paint(null)),
    open: () => void opts.load().then((r) => (paint(r), open())),
  };
}
