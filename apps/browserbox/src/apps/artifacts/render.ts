import type { Artifact } from '@jeevanand/agent-browserbox/ui';
import { htmlFrame } from '@/apps/preview/views';
import type { PreviewStore } from '@/app/preview-storage';
import { h } from '@/ui/dom';
import { renderMarkdown } from '@/ui/markdown';

/**
 * How each kind of artifact is shown. Nothing an artifact contains can reach
 * BrowserBox itself: HTML and Mermaid run in the preview's opaque-origin frame,
 * Markdown goes through the app's sanitising renderer, and SVG is shown as an
 * image, so scripts inside it never run.
 */
export async function renderArtifact(a: Artifact, content: string, store?: (key: string) => PreviewStore): Promise<HTMLElement> {
  switch (a.kind) {
    case 'html':
      return h('div', { class: 'af-frame' }, htmlFrame(content, a.title, null, store?.(`artifact:${a.id}`)));
    case 'markdown':
      return h('div', { class: 'af-doc md' }, renderMarkdown(content));
    case 'svg':
      return imageOf(content);
    case 'mermaid':
      return mermaid(content, a.title);
    case 'csv':
      return table(content);
    default:
      return h('pre', { class: 'af-code', tabindex: 0 }, h('code', { 'data-lang': a.language ?? '' }, content));
  }
}

function imageOf(svg: string): HTMLElement {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  return h('div', { class: 'af-image' }, h('img', { src: url, alt: 'SVG image', onload: () => URL.revokeObjectURL(url) }));
}

/**
 * Mermaid draws in the sandboxed preview frame, like an HTML artifact: the app
 * page's content security policy allows no scripts from elsewhere (rightly), and
 * a third-party library stays isolated there. Pinned version, strict mode.
 */
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function mermaid(src: string, title: string): HTMLElement {
  const doc = `<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;font:14px system-ui}pre.err{white-space:pre-wrap;color:#a33;padding:16px}</style>
<pre class="mermaid">${escapeHtml(src)}</pre>
<script type="module">
try {
  const { default: m } = await import(${JSON.stringify(MERMAID)});
  m.initialize({ startOnLoad: false, securityLevel: 'strict' });
  await m.run({ querySelector: '.mermaid' });
} catch (e) {
  document.body.innerHTML = '<pre class="err"></pre>';
  document.querySelector('pre').textContent = 'The diagram could not be drawn (' + e.message + '). Its source:\\n\\n' + ${JSON.stringify(src)};
}
</script>`;
  return h('div', { class: 'af-frame' }, htmlFrame(doc, title));
}

/** RFC 4180-style CSV: quoted fields, "" for a quote, commas and new lines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c !== ''));
}

function table(text: string): HTMLElement {
  const [head = [], ...body] = parseCsv(text);
  let sortBy = -1;
  let asc = true;
  const tbody = h('tbody');
  const fill = () => {
    const rows = sortBy < 0 ? body : [...body].sort((a, b) => {
      const x = a[sortBy] ?? '';
      const y = b[sortBy] ?? '';
      const nx = Number(x);
      const ny = Number(y);
      const r = x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
      return asc ? r : -r;
    });
    tbody.replaceChildren(...rows.map((r) => h('tr', null, head.map((_, i) => h('td', null, r[i] ?? '')))));
  };
  const ths = head.map((name, i) =>
    h('th', { scope: 'col' }, h('button', { type: 'button', class: 'af-sort', onclick: () => ((asc = sortBy === i ? !asc : true), (sortBy = i), mark(), fill()) }, name)),
  );
  const mark = () => ths.forEach((th, i) => th.setAttribute('aria-sort', i === sortBy ? (asc ? 'ascending' : 'descending') : 'none'));
  fill();
  return h('div', { class: 'af-table-wrap' }, h('table', { class: 'af-table' }, h('thead', null, h('tr', null, ths)), tbody), h('p', { class: 'af-note' }, `${body.length} rows`));
}
