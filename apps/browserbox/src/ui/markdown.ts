import { h } from './dom';

/**
 * A small, safe Markdown renderer. It builds DOM nodes directly — model output
 * is never parsed as HTML — and only http(s)/mailto links become clickable.
 */
export interface MarkdownHooks {
  /** Draws a fenced block itself (e.g. ```ui); `closed` is false while it is still streaming. Null: shown as code. */
  block?(lang: string, code: string, closed: boolean): Node | null;
}

export function renderMarkdown(src: string, hooks: MarkdownHooks = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+[.)])\s+|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) body.push(lines[i]!);
      const closed = i < lines.length;
      i++;
      const code = body.join('\n');
      const own = hooks.block?.(fence[2] ?? '', code, closed);
      if (own) {
        frag.append(own);
        continue;
      }
      frag.append(
        h(
          'div',
          { class: 'md-code' },
          h('div', { class: 'md-code-bar' }, h('span', null, fence[2] || 'text'), h('button', { class: 'btn ghost small', onclick: (e: Event) => copy(e.currentTarget as HTMLElement, code) }, 'Copy')),
          h('pre', null, h('code', null, code)),
        ),
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const el = h(`h${Math.min(heading[1]!.length + 1, 6)}` as 'h2');
      inline(el, heading[2]!.replace(/\s+#+\s*$/, ''));
      frag.append(el);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      frag.append(h('hr'));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^>\s?/, ''));
      const q = h('blockquote');
      q.append(renderMarkdown(body.join('\n'), hooks));
      frag.append(q);
      continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = h('tr', null, cells(line).map((c) => inline(h('th'), c)));
      const rows: HTMLElement[] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(h('tr', null, cells(lines[i]!).map((c) => inline(h('td'), c))));
      frag.append(h('div', { class: 'md-table' }, h('table', { class: 'table' }, h('thead', null, head), h('tbody', null, rows))));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]!);
      const list = h(ordered ? 'ol' : 'ul');
      const indent = item[1]!.length;
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || m[1]!.length < indent) break;
        if (m[1]!.length > indent) {
          // Nested list: render the deeper block into the previous item.
          const nested: string[] = [];
          for (; i < lines.length && (/^\s*$/.test(lines[i]!) ? false : (/^(\s*)/.exec(lines[i]!)![1]!.length > indent)); i++) nested.push(lines[i]!.slice(indent + 2));
          (list.lastElementChild ?? list).append(renderMarkdown(nested.join('\n')));
          continue;
        }
        const li = h('li');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
        if (task) li.append(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' }), ' ');
        inline(li, task ? task[2]! : m[3]!);
        list.append(li);
        i++;
        // Lazy continuation lines belong to the same item.
        while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!) && /^\s+/.test(lines[i]!)) inline(li, ' ' + lines[i++]!.trim());
      }
      frag.append(list);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !(para.length && isBlockStart(lines[i]!)); i++) para.push(lines[i]!);
    frag.append(inline(h('p'), para.join('\n')));
  }
  return frag;
}

function copy(btn: HTMLElement, text: string): void {
  void navigator.clipboard?.writeText(text).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy'), 1200);
  });
}

const INLINE = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^\s*][\s\S]*?)\*|\b_([^\s_][\s\S]*?)_\b|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]+)/g;

/** Inline Markdown (code, bold, italics, links) into `el`. */
export function inline<T extends HTMLElement>(el: T, text: string): T {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== undefined) el.append(h('code', null, m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) el.append(inline(h('strong'), (m[3] ?? m[4])!));
    else if (m[5] !== undefined || m[6] !== undefined) el.append(inline(h('em'), (m[5] ?? m[6])!));
    else if (m[7] !== undefined) el.append(inline(h('del'), m[7]));
    else {
      const href = m[9] ?? m[10]!;
      const label = m[8] ?? m[10]!;
      if (/^(https?:|mailto:)/i.test(href)) el.append(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label));
      else el.append(m[0]);
    }
  }
  if (last < text.length) el.append(text.slice(last));
  return el;
}
