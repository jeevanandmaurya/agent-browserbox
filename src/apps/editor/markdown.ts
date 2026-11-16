/**
 * A small, safe Markdown → DOM renderer (CommonMark-ish plus GFM tables,
 * task lists, strikethrough and autolinks). It only ever creates elements and
 * text nodes, so raw HTML in the source is shown as text, never parsed.
 */
import { h } from '@/ui/dom';
import './markdown.css';

export interface MarkdownOptions {
  /** Called for clicks on relative links; when absent they are inert. */
  onLink?: (href: string) => void;
  /** Called for relative image srcs; sets `img.src` (e.g. to a blob URL) when it can. */
  resolveImage?: (src: string, img: HTMLImageElement) => void;
}

const SAFE_URL = /^(https?:|mailto:)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  blocks(src.replace(/\r\n?/g, '\n').split('\n'), frag, opts);
  return frag;
}

const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/,
  heading: /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/,
  hr: /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^ {0,3}>/,
  list: /^( *)([-*+]|\d{1,9}[.)])(\s+|$)/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  setext: /^ {0,3}(=+|-+)\s*$/,
};

function startsBlock(line: string): boolean {
  return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.list.test(line);
}

function blocks(lines: string[], out: Node, opts: MarkdownOptions): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;
    if (!line.trim()) {
      i++;
    } else if ((m = line.match(RE.fence))) {
      const fence = m[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence); i++) body.push(lines[i]!);
      i++;
      const code = h('code', m[2] ? { class: `language-${m[2]}` } : null, body.join('\n'));
      out.appendChild(h('pre', null, code));
    } else if ((m = line.match(RE.heading))) {
      const tag = `h${m[1]!.length}` as 'h1';
      out.appendChild(h(tag, null, inline(m[2] ?? '', opts)));
      i++;
    } else if (RE.hr.test(line)) {
      out.appendChild(h('hr'));
      i++;
    } else if (RE.quote.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && (RE.quote.test(lines[i]!) || !startsBlock(lines[i]!)); i++) {
        body.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
      }
      const q = h('blockquote');
      blocks(body, q, opts);
      out.appendChild(q);
    } else if (RE.list.test(line)) {
      i = list(lines, i, out, opts);
    } else if (line.includes('|') && RE.tableSep.test(lines[i + 1] ?? '')) {
      i = table(lines, i, out, opts);
    } else if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && (/^( {4}|\t)/.test(lines[i]!) || !lines[i]!.trim()); i++) body.push(lines[i]!.replace(/^( {4}|\t)/, ''));
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      out.appendChild(h('pre', null, h('code', null, body.join('\n'))));
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i]!.trim(); i++) {
        const s = lines[i]!.match(RE.setext);
        if (s) {
          out.appendChild(h(s[1]![0] === '=' ? 'h1' : 'h2', null, inline(para.join('\n'), opts)));
          para.length = 0;
          i++;
          break;
        }
        if (startsBlock(lines[i]!)) break;
        para.push(lines[i]!);
      }
      if (para.length) out.appendChild(h('p', null, inline(para.join('\n'), opts)));
    }
  }
}

function list(lines: string[], i: number, out: Node, opts: MarkdownOptions): number {
  const first = lines[i]!.match(RE.list)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const el = ordered ? h('ol', Number.parseInt(first[2]!, 10) !== 1 ? { start: Number.parseInt(first[2]!, 10) } : null) : h('ul');
  let loose = false;
  const items: string[][] = [];
  while (i < lines.length) {
    const m = lines[i]!.match(RE.list);
    if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
    const width = m[0].length;
    const item = [lines[i]!.slice(width)];
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim()) {
        // A blank line continues the item only if indented content follows.
        const next = lines[i + 1];
        if (next !== undefined && next.trim() && /^\s*/.exec(next)![0].length > indent) {
          item.push('');
          loose = true;
          continue;
        }
        break;
      }
      const lead = /^\s*/.exec(l)![0].length;
      if (lead > indent) item.push(l.slice(Math.min(lead, width)));
      else if (!startsBlock(l)) item.push(l.trim());
      else break;
    }
    items.push(item);
    if (!lines[i]?.trim() && RE.list.test(lines[i + 1] ?? '') && lines[i + 1]!.match(RE.list)![1]!.length === indent) {
      loose = true;
      i++;
    }
  }
  for (const item of items) {
    const li = h('li');
    const task = item[0]!.match(/^\[([ xX])\]\s+/);
    if (task) {
      item[0] = item[0]!.slice(task[0].length);
      li.className = 'task';
      li.appendChild(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ', 'aria-label': 'task' }));
    }
    const body = document.createDocumentFragment();
    blocks(item, body, opts);
    // Tight lists render their paragraphs inline.
    if (!loose) for (const p of [...body.childNodes]) if (p instanceof HTMLParagraphElement) p.replaceWith(...p.childNodes);
    li.appendChild(body);
    el.appendChild(li);
  }
  out.appendChild(el);
  return i;
}

function cells(row: string): string[] {
  const s = row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(lines: string[], i: number, out: Node, opts: MarkdownOptions): number {
  const head = cells(lines[i]!);
  const align = cells(lines[i + 1]!).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : c.startsWith(':') ? 'left' : ''));
  const style = (j: number) => (align[j] ? `text-align:${align[j]}` : null);
  const tbody = h('tbody');
  for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes('|'); i++) {
    const row = cells(lines[i]!);
    tbody.appendChild(h('tr', null, head.map((_, j) => h('td', { style: style(j) }, inline(row[j] ?? '', opts)))));
  }
  const thead = h('thead', null, h('tr', null, head.map((c, j) => h('th', { style: style(j) }, inline(c, opts)))));
  out.appendChild(h('div', { class: 'md-table' }, h('table', null, thead, tbody)));
  return i;
}

/** Finds the `]` matching the `[` at `start`, honouring nesting and escapes. */
function closeBracket(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '[') depth++;
    else if (s[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

/** Parses `(url "title")` at `start`; returns the url and the index after `)`. */
function destination(s: string, start: number): { url: string; end: number } | null {
  if (s[start] !== '(') return null;
  const m = /^\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+("[^"]*"|'[^']*'))?\s*\)/.exec(s.slice(start));
  if (!m) return null;
  return { url: m[1]!.replace(/^<|>$/g, ''), end: start + m[0].length };
}

function link(href: string, children: Node[], opts: MarkdownOptions): Node {
  if (SAFE_URL.test(href)) return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children);
  if (href.startsWith('#')) return h('a', { href }, children);
  if (HAS_SCHEME.test(href) || !opts.onLink) return h('span', { class: 'md-link', title: href }, children);
  // Relative link: never let it navigate the OS page itself.
  return h('a', { href: '#', title: href, onclick: (e: Event) => (e.preventDefault(), opts.onLink!(href)) }, children);
}

function image(src: string, alt: string, opts: MarkdownOptions): Node {
  const img = h('img', { alt, loading: 'lazy' });
  if (/^(https?:|data:image\/)/i.test(src) && !/^data:image\/svg/i.test(src)) img.src = src;
  else if (!HAS_SCHEME.test(src) && opts.resolveImage) opts.resolveImage(src, img);
  else return document.createTextNode(alt);
  return img;
}

const DELIMS: Array<[string, 'strong' | 'em' | 'del']> = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']];

export function inline(s: string, opts: MarkdownOptions): Node[] {
  const out: Node[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push(document.createTextNode(text));
    text = '';
  };
  const push = (n: Node) => (flush(), out.push(n));
  let i = 0;
  outer: while (i < s.length) {
    const c = s[i]!;
    const rest = s.slice(i);
    if (c === '\\' && /[!-/:-@[-`{-~]/.test(s[i + 1] ?? '')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      push(h('br'));
      i += 2;
      continue;
    }
    if (c === '\n') {
      if (text.endsWith('  ')) {
        text = text.trimEnd();
        push(h('br'));
      } else text = text.trimEnd() + ' ';
      i++;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(rest)![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) {
        push(h('code', null, s.slice(i + run.length, end).replace(/\n/g, ' ').trim()));
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if ((c === '!' && s[i + 1] === '[') || c === '[') {
      const open = c === '!' ? i + 1 : i;
      const close = closeBracket(s, open);
      const dest = close > 0 ? destination(s, close + 1) : null;
      if (dest) {
        const label = s.slice(open + 1, close);
        push(c === '!' ? image(dest.url, label, opts) : link(dest.url, inline(label, opts), opts));
        i = dest.end;
        continue;
      }
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      if (m) {
        push(link(m[1]!, [document.createTextNode(m[1]!.replace(/^mailto:/i, ''))], opts));
        i += m[0].length;
        continue;
      }
    }
    if (c === 'h' && !/\w$/.test(text)) {
      const m = /^https?:\/\/[^\s<>]+/.exec(rest);
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]'"]+$/, '');
        push(link(url, [document.createTextNode(url)], opts));
        i += url.length;
        continue;
      }
    }
    for (const [d, tag] of DELIMS) {
      if (!rest.startsWith(d) || /\s/.test(s[i + d.length] ?? ' ')) continue;
      if (d[0] === '_' && /\w/.test(s[i - 1] ?? '')) continue; // no intraword underscores
      let end = s.indexOf(d, i + d.length + 1);
      while (end > 0 && (/\s/.test(s[end - 1]!) || (d.length === 1 && s[end + 1] === d))) end = s.indexOf(d, end + 2);
      if (end < 0) continue;
      push(h(tag, null, inline(s.slice(i + d.length, end), opts)));
      i = end + d.length;
      continue outer;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}
