import { h } from '@/ui/dom';
import { inline, renderMarkdown } from '@/ui/markdown';
import { parseUi, type Expr, type Program } from './ui-lang';
import './ui-blocks.css';

/**
 * Draws a ```ui block (see ui-lang.ts and the agent's ui-spec.ts) with the
 * app's own styles. Loaded the first time a reply has one. Model output is
 * never HTML: every element is built here, and actions go through `host`.
 */
export interface UiAction {
  name: string;
  args: unknown[];
}

export interface UiHost {
  /** @ToAssistant (a reply), @OpenUrl, @Open. */
  act(action: UiAction): void;
  /** Reads a file of the box (for Image). */
  readFile?(path: string): Promise<Uint8Array>;
}

type Value = string | number | boolean | null | Value[] | { [k: string]: Value } | Node_ | Action | Pending;
interface Node_ {
  kind: 'node';
  name: string;
  args: Value[];
}
interface Action {
  kind: 'action';
  name: string;
  args: Value[];
}
interface Pending {
  kind: 'pending';
}

/** A Form's fields, read when it is sent. */
interface FormScope {
  fields: Map<string, () => string>;
}

const isObj = (v: Value): v is { [k: string]: Value } => !!v && typeof v === 'object' && !Array.isArray(v) && !('kind' in v);
const isNode = (v: Value, name?: string): v is Node_ => !!v && typeof v === 'object' && !Array.isArray(v) && (v as Node_).kind === 'node' && (!name || (v as Node_).name === name);
const isAction = (v: Value): v is Action => !!v && typeof v === 'object' && !Array.isArray(v) && (v as Action).kind === 'action';
const str = (v: Value | undefined, fallback = ''): string => (v === undefined || v === null || typeof v === 'object' ? fallback : String(v));
const num = (v: Value | undefined, fallback = 0): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : fallback);
const list = (v: Value | undefined): Value[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const COLORS = ['#4f8ef7', '#e8a33d', '#3fb68b', '#d9534f', '#9b6cd6', '#2bb3c0'];

class Renderer {
  #memo = new Map<string, Value>();

  constructor(
    private prog: Program,
    private complete: boolean,
    private host: UiHost,
  ) {}

  value(e: Expr, seen: Set<string> = new Set()): Value {
    switch (e.t) {
      case 'str':
      case 'num':
      case 'bool':
        return e.v;
      case 'null':
        return null;
      case 'arr':
        return e.items.map((x) => this.value(x, seen));
      case 'obj':
        return Object.fromEntries(e.entries.map(([k, x]) => [k, this.value(x, seen)]));
      case 'state':
      case 'ref': {
        const name = e.t === 'state' ? `$${e.name}` : e.name;
        if (this.#memo.has(name)) return this.#memo.get(name)!;
        const def = this.prog.defs.get(name);
        // Not here yet (still streaming), or never defined: a placeholder, or nothing.
        if (!def || seen.has(name)) return this.complete || seen.has(name) ? null : { kind: 'pending' };
        const v = this.value(def, new Set([...seen, name]));
        this.#memo.set(name, v);
        return v;
      }
      case 'call':
        return { kind: 'node', name: e.name, args: e.args.map((x) => this.value(x, seen)) };
      case 'action':
        return { kind: 'action', name: e.name, args: e.args.map((x) => this.value(x, seen)) };
    }
  }

  /** Positional arguments; a trailing {key: value} object fills arguments by name. */
  args(n: Node_, names: string[]): Value[] {
    const out = [...n.args];
    const last = out.at(-1);
    if (last !== undefined && isObj(last) && names.some((k) => k in last)) {
      out.pop();
      names.forEach((k, i) => k in last && (out[i] = last[k]!));
    }
    return out;
  }

  node(v: Value, form?: FormScope): Node {
    if (v === null || v === undefined || v === false) return document.createTextNode('');
    if (typeof v !== 'object') return inline(h('span', { class: 'ui-text' }), String(v));
    if (Array.isArray(v)) {
      const frag = document.createDocumentFragment();
      for (const x of v) frag.append(this.node(x, form));
      return frag;
    }
    if ((v as Pending).kind === 'pending') return h('div', { class: 'ui-pending', 'aria-hidden': 'true' });
    if (isAction(v)) return this.button(`${v.name.slice(1)}`, v, 'secondary');
    if (!isNode(v)) return document.createTextNode('');
    const draw = DRAW[v.name];
    if (!draw) {
      // A component this chat does not know: its content, if it has any.
      const inner = v.args.filter((a) => typeof a === 'object' && a !== null);
      return inner.length ? h('div', { class: 'ui-stack' }, inner.map((a) => this.node(a, form))) : h('span', { class: 'ui-muted' }, `${v.name}(…)`);
    }
    try {
      return draw(this, this.args(v, ARGS[v.name] ?? []), form);
    } catch (err) {
      return h('span', { class: 'ui-muted' }, `${v.name}: ${(err as Error).message}`);
    }
  }

  run(a: Action | undefined, extra?: string): void {
    if (!a) return;
    const args = a.args.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x));
    if (extra !== undefined) args[0] = args[0] ? `${String(args[0])}\n${extra}` : extra;
    this.host.act({ name: a.name, args });
  }

  button(label: string, action: Action | undefined, style: string): HTMLElement {
    const known = !!action && ['@ToAssistant', '@OpenUrl', '@Open'].includes(action.name);
    const b = h(
      'button',
      {
        class: `btn small${style === 'primary' ? ' primary' : ''}`,
        type: 'button',
        disabled: !known,
        title: known ? '' : 'This action is not available here',
        onclick: () => {
          if (action?.name === '@ToAssistant') b.classList.add('ui-chosen');
          this.run(action);
        },
      },
      label,
    );
    return b;
  }

  image(src: string, alt: string): HTMLElement {
    const img = h('img', { alt, loading: 'lazy' }) as HTMLImageElement;
    if (/^https:\/\//.test(src)) img.src = src;
    else if (src.startsWith('/') && this.host.readFile)
      void this.host.readFile(src).then(
        (bytes) => (img.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: /\.svg$/i.test(src) ? 'image/svg+xml' : '' }))),
        () => img.replaceWith(h('span', { class: 'ui-muted' }, `${alt || src} (not found)`)),
      );
    return h('figure', { class: 'ui-image' }, img, alt ? h('figcaption', null, alt) : null);
  }
}

const ARGS: Record<string, string[]> = {
  Stack: ['children', 'direction'],
  Card: ['title', 'children'],
  Text: ['text', 'style'],
  Callout: ['text', 'tone'],
  Stats: ['stats'],
  Stat: ['label', 'value', 'change'],
  Table: ['columns', 'rows'],
  Chart: ['kind', 'labels', 'series', 'title'],
  Series: ['name', 'values'],
  Progress: ['label', 'value', 'max'],
  Checklist: ['items'],
  Item: ['text', 'done'],
  Buttons: ['buttons'],
  Button: ['label', 'action', 'style'],
  Choices: ['id', 'label', 'options', 'multiple'],
  Form: ['id', 'fields', 'submit'],
  Input: ['id', 'label', 'placeholder', 'kind'],
  Select: ['id', 'label', 'options'],
  Checkbox: ['id', 'label', 'checked'],
  Slider: ['id', 'label', 'min', 'max', 'value'],
  Link: ['label', 'target'],
  Image: ['src', 'alt'],
  Code: ['text', 'language'],
  Divider: [],
};

type Draw = (r: Renderer, a: Value[], form?: FormScope) => Node;

const field = (label: string, control: HTMLElement): HTMLElement => h('label', { class: 'ui-field' }, h('span', null, label), control);

const DRAW: Record<string, Draw> = {
  Stack: (r, [children, dir], form) => h('div', { class: `ui-stack${str(dir) === 'row' ? ' row' : ''}` }, r.node(list(children), form)),
  Card: (r, [title, children], form) => h('section', { class: 'ui-card' }, str(title) ? h('h4', null, str(title)) : null, h('div', { class: 'ui-stack' }, r.node(list(children), form))),
  Text: (_r, [text, style]) => {
    const el = h('div', { class: `ui-p ${['title', 'muted', 'small'].includes(str(style)) ? str(style) : ''}` });
    el.append(renderMarkdown(str(text)));
    return el;
  },
  Callout: (_r, [text, tone]) => {
    const el = h('div', { class: `ui-callout ${['ok', 'warn', 'error'].includes(str(tone)) ? str(tone) : 'info'}`, role: 'note' });
    el.append(renderMarkdown(str(text)));
    return el;
  },
  Stats: (r, [stats], form) => h('div', { class: 'ui-stats' }, r.node(list(stats), form)),
  Stat: (_r, [label, value, change]) => {
    const c = str(change);
    return h('div', { class: 'ui-stat' }, h('span', { class: 'ui-stat-label' }, str(label)), h('strong', null, str(value)), c ? h('span', { class: `ui-stat-change ${/^-|−/.test(c) ? 'down' : 'up'}` }, c) : null);
  },
  Table: (_r, [columns, rows]) => {
    const cols = list(columns).map((c) => str(c));
    let data = list(rows).map((row) => list(row));
    const body = h('tbody');
    const fill = () => body.replaceChildren(...data.map((row) => h('tr', null, row.map((c) => inline(h('td', { class: typeof c === 'number' ? 'num' : '' }), str(c))))));
    let sorted = -1;
    let asc = true;
    const head = h(
      'tr',
      null,
      cols.map((c, i) =>
        h('th', null, h('button', { type: 'button', class: 'ui-sort', onclick: () => {
          asc = sorted === i ? !asc : true;
          sorted = i;
          data = [...data].sort((a, b) => {
            const x = a[i];
            const y = b[i];
            const d = typeof x === 'number' && typeof y === 'number' ? x - y : str(x).localeCompare(str(y), undefined, { numeric: true });
            return asc ? d : -d;
          });
          fill();
        } }, c)),
      ),
    );
    fill();
    return h('div', { class: 'ui-table' }, h('table', null, h('thead', null, head), body));
  },
  Series: () => document.createTextNode(''),
  Chart: (_r, [kind, labels, series, title]) => chart(str(kind, 'bar'), list(labels).map((l) => str(l)), seriesOf(series ?? null), str(title)),
  Progress: (_r, [label, value, max]) => {
    const m = num(max, 100) || 100;
    const pct = Math.max(0, Math.min(100, (num(value) / m) * 100));
    return h('div', { class: 'ui-progress' }, h('div', { class: 'ui-progress-top' }, h('span', null, str(label)), h('span', { class: 'ui-muted' }, `${Math.round(pct)}%`)), h('div', { class: 'ui-bar', role: 'progressbar', 'aria-valuenow': String(Math.round(pct)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': str(label) }, h('i', { style: `width:${pct}%` })));
  },
  Checklist: (_r, [items]) =>
    h(
      'ul',
      { class: 'ui-checklist' },
      list(items).map((it) => {
        const [text, done] = isNode(it, 'Item') ? it.args : [it, false];
        return h('li', { class: done === true ? 'done' : '' }, h('span', { class: 'ui-tick', 'aria-label': done === true ? 'done' : 'to do' }, done === true ? '✓' : ''), inline(h('span'), str(text)));
      }),
    ),
  Item: (_r, [text]) => inline(h('span'), str(text)),
  Buttons: (r, [buttons], form) => h('div', { class: 'ui-buttons' }, r.node(list(buttons), form)),
  Button: (r, [label, action, style]) => r.button(str(label, 'OK'), isAction(action as Value) ? (action as Action) : undefined, str(style)),
  Choices: (r, [id, label, options, multiple], form) => {
    const opts = list(options).map((o) => str(o));
    const many = multiple === true;
    const picked = new Set<string>();
    const box = h('div', { class: 'ui-choices', role: many ? 'group' : 'radiogroup', 'aria-label': str(label) });
    for (const o of opts) {
      const chip = h('button', { type: 'button', class: 'ui-chip', role: many ? 'checkbox' : 'radio', 'aria-checked': 'false' }, o);
      chip.onclick = () => {
        if (!many) picked.clear();
        if (picked.has(o)) picked.delete(o);
        else picked.add(o);
        for (const c of box.querySelectorAll<HTMLElement>('.ui-chip')) c.setAttribute('aria-checked', String(picked.has(c.textContent ?? '')));
        // On its own (not in a form), a single choice is the reply.
        if (!form && !many) {
          for (const c of box.querySelectorAll<HTMLButtonElement>('.ui-chip')) c.disabled = true;
          r.run({ kind: 'action', name: '@ToAssistant', args: [str(label) ? `${str(label)}: ${o}` : o] });
        }
      };
      box.append(chip);
    }
    form?.fields.set(str(id, str(label)), () => [...picked].join(', '));
    const parts: HTMLElement[] = [str(label) ? h('span', { class: 'ui-label' }, str(label)) : h('span'), box];
    // Several choices on their own: a button sends them.
    if (!form && many) parts.push(h('div', { class: 'ui-buttons' }, h('button', { class: 'btn small primary', type: 'button', onclick: (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      r.run({ kind: 'action', name: '@ToAssistant', args: [`${str(label) || 'Chosen'}: ${[...picked].join(', ') || 'none'}`] });
    } }, 'Send')));
    return h('div', { class: 'ui-field' }, ...parts);
  },
  Form: (r, [id, fields, submit]) => {
    const scope: FormScope = { fields: new Map() };
    const form = h('form', { class: 'ui-form' }) as HTMLFormElement;
    form.append(r.node(list(fields), scope));
    const send = h('button', { class: 'btn small primary', type: 'submit' }, str(submit, 'Send'));
    form.append(h('div', { class: 'ui-buttons' }, send));
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const lines = [...scope.fields].map(([k, get]) => `- ${k}: ${get() || '(empty)'}`);
      for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, select, textarea, button')) el.disabled = true;
      send.textContent = 'Sent';
      r.run({ kind: 'action', name: '@ToAssistant', args: [`${str(id) ? `Form “${str(id)}”` : 'Form'}:\n${lines.join('\n')}`] });
    };
    return form;
  },
  Input: (_r, [id, label, placeholder, kind], form) => {
    const k = str(kind, 'text');
    const control = (k === 'textarea' ? h('textarea', { class: 'input', rows: 3, placeholder: str(placeholder) }) : h('input', { class: 'input', type: ['number', 'email', 'date', 'time'].includes(k) ? k : 'text', placeholder: str(placeholder) })) as HTMLInputElement;
    form?.fields.set(str(id, str(label)), () => control.value);
    return field(str(label), control);
  },
  Select: (_r, [id, label, options], form) => {
    const control = h('select', { class: 'select' }, list(options).map((o) => h('option', { value: str(o) }, str(o)))) as HTMLSelectElement;
    form?.fields.set(str(id, str(label)), () => control.value);
    return field(str(label), control);
  },
  Checkbox: (_r, [id, label, checked], form) => {
    const control = h('input', { type: 'checkbox', checked: checked === true }) as HTMLInputElement;
    form?.fields.set(str(id, str(label)), () => (control.checked ? 'yes' : 'no'));
    return h('label', { class: 'ui-check' }, control, h('span', null, str(label)));
  },
  Slider: (_r, [id, label, min, max, value], form) => {
    const lo = num(min);
    const hi = num(max, 100);
    const control = h('input', { type: 'range', min: String(lo), max: String(hi), value: String(num(value, lo)) }) as HTMLInputElement;
    const out = h('output', null, control.value);
    control.oninput = () => (out.textContent = control.value);
    form?.fields.set(str(id, str(label)), () => control.value);
    return field(str(label), h('div', { class: 'ui-slider' }, control, out));
  },
  Link: (r, [label, target]) => {
    const t = str(target);
    return h('a', { class: 'ui-link', href: /^https?:\/\//.test(t) ? t : '#', onclick: (e: Event) => (e.preventDefault(), r.run({ kind: 'action', name: /^https?:\/\//.test(t) ? '@OpenUrl' : '@Open', args: [t] })) }, str(label, t));
  },
  Image: (r, [src, alt]) => r.image(str(src), str(alt)),
  Code: (_r, [text]) => h('pre', { class: 'ui-code' }, h('code', null, str(text))),
  Divider: () => h('hr', { class: 'ui-hr' }),
};

function seriesOf(v: Value): Array<{ name: string; values: number[] }> {
  const items = list(v);
  // A plain list of numbers is one unnamed series.
  if (items.length && items.every((x) => typeof x === 'number' || typeof x === 'string')) return [{ name: '', values: items.map((x) => num(x)) }];
  return items.filter((s) => isNode(s, 'Series')).map((s) => ({ name: str((s as Node_).args[0]), values: list((s as Node_).args[1]).map((x) => num(x)) }));
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number>, ...children: Node[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** Bar, line and pie charts, drawn as SVG that scales with the chat. */
function chart(kind: string, labels: string[], series: Array<{ name: string; values: number[] }>, title: string): HTMLElement {
  const W = 480;
  const H = 220;
  const pad = { l: 40, r: 10, t: 10, b: 28 };
  const box = h('figure', { class: 'ui-chart' });
  if (title) box.append(h('figcaption', null, title));
  if (!series.length || !series[0]!.values.length) return box;
  const tip = (text: string) => svg('title', {}, document.createTextNode(text));
  if (kind === 'pie') {
    const vals = series[0]!.values.map((x) => Math.max(0, x));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const g = svg('svg', { viewBox: '0 0 220 220', role: 'img', 'aria-label': title || 'Pie chart' });
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0, x1, y1] = [110 + 100 * Math.cos(a0), 110 + 100 * Math.sin(a0), 110 + 100 * Math.cos(a1), 110 + 100 * Math.sin(a1)];
      g.append(svg(vals.length === 1 ? 'circle' : 'path', vals.length === 1 ? { cx: 110, cy: 110, r: 100, fill: COLORS[0]! } : { d: `M110,110 L${x0},${y0} A100,100 0 ${large} 1 ${x1},${y1} Z`, fill: COLORS[i % COLORS.length]! }, tip(`${labels[i] ?? i + 1}: ${v}`)));
      a0 = a1;
    });
    box.append(h('div', { class: 'ui-pie' }, g as unknown as HTMLElement, legend(labels.map((l, i) => [l, COLORS[i % COLORS.length]!]))));
    return box;
  }
  const all = series.flatMap((s) => s.values);
  // Round steps (1, 2, 2.5 or 5 × a power of ten) so the axis reads 0, 2.5, 5…
  const raw = (Math.max(0, ...all) - Math.min(0, ...all)) / 4 || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const max = Math.ceil(Math.max(0, ...all) / unit) * unit;
  const min = Math.floor(Math.min(0, ...all) / unit) * unit;
  const span = max - min || 1;
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const x = (i: number, w = 0) => pad.l + ((W - pad.l - pad.r) / n) * i + w;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title || `${kind} chart` });
  // Gridlines with their values.
  for (let v = min; v <= max + unit / 2; v += unit) {
    g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'ui-grid' }), svg('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'ui-axis' }, document.createTextNode(fmt(v))));
  }
  const step = (W - pad.l - pad.r) / n;
  labels.forEach((l, i) => g.append(svg('text', { x: x(i, step / 2), y: H - 8, 'text-anchor': 'middle', class: 'ui-axis' }, document.createTextNode(l.length > 10 ? `${l.slice(0, 9)}…` : l))));
  if (kind === 'line') {
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${x(i, step / 2)},${y(v)}`).join(' ');
      g.append(svg('polyline', { points: pts, fill: 'none', stroke: COLORS[si % COLORS.length]!, 'stroke-width': 2.5 }));
      s.values.forEach((v, i) => g.append(svg('circle', { cx: x(i, step / 2), cy: y(v), r: 3.5, fill: COLORS[si % COLORS.length]! }, tip(`${s.name ? `${s.name} · ` : ''}${labels[i] ?? i + 1}: ${v}`))));
    });
  } else {
    const bw = (step * 0.7) / series.length;
    series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const top = y(Math.max(v, 0));
        g.append(svg('rect', { x: x(i, step * 0.15 + bw * si), y: top, width: Math.max(1, bw - 2), height: Math.max(1, Math.abs(y(v) - y(0))), rx: 2, fill: COLORS[si % COLORS.length]! }, tip(`${s.name ? `${s.name} · ` : ''}${labels[i] ?? i + 1}: ${v}`)));
      }),
    );
  }
  box.append(g as unknown as HTMLElement);
  if (series.length > 1 || series[0]!.name) box.append(legend(series.map((s, i) => [s.name || `Series ${i + 1}`, COLORS[i % COLORS.length]!])));
  return box;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${+v.toFixed(2)}`);
const legend = (items: Array<[string, string]>) => h('div', { class: 'ui-legend' }, items.map(([name, color]) => h('span', null, h('i', { style: `background:${color}` }), name)));

/**
 * Draws `src` into `el`. While the block streams (`complete` false), only
 * whole lines are drawn, and names not yet defined show as placeholders.
 */
export function renderUi(el: HTMLElement, src: string, complete: boolean, host: UiHost): void {
  const prog = parseUi(src, complete);
  if (prog.errors.length && complete) console.warn('[ui block]', prog.errors);
  const r = new Renderer(prog, complete, host);
  if (!prog.root) return void el.replaceChildren(complete ? h('pre', { class: 'ui-code' }, h('code', null, src)) : h('div', { class: 'ui-pending' }));
  el.replaceChildren(r.node(r.value({ t: 'ref', name: prog.root })));
}
