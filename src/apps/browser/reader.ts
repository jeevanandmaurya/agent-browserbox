/**
 * Reader mode: fetches a page (CORS permitting), extracts the main content
 * and rebuilds it from a tag whitelist. Fetched markup is never injected.
 */
import { h } from '@/ui/dom';

export interface Article {
  title: string;
  site: string;
  words: number;
  body: HTMLElement;
}

export class ReaderError extends Error {}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 20000;

const JUNK =
  'script, style, noscript, template, nav, footer, aside, form, iframe, frame, object, embed, svg, canvas, video, audio, button, input, select, textarea, dialog, link, meta, ' +
  '[role=navigation], [role=banner], [role=contentinfo], [role=complementary], [aria-hidden=true], [hidden], .mw-editsection, .navbox, .metadata, .noprint';
const JUNK_NAME = /(^|[\s_-])(comments?|share|social|sidebar|promo|advert|ads?|cookie|newsletter|related|menu|breadcrumbs?|subscribe|popup|modal)([\s_-]|$)/i;

/** Wikipedia article HTML has no CORS headers, but its REST API does. */
function fetchUrlFor(url: URL): string {
  const wiki = /^([a-z-]+)\.(?:m\.)?wikipedia\.org$/.exec(url.hostname);
  const title = /^\/wiki\/(.+)$/.exec(url.pathname)?.[1];
  if (wiki && title) return `https://${wiki[1]}.wikipedia.org/api/rest_v1/page/html/${title}`;
  return url.href;
}

export async function loadArticle(href: string, signal: AbortSignal, navigate: (url: string) => void): Promise<Article> {
  const url = new URL(href);
  let res: Response;
  try {
    res = await fetch(fetchUrlFor(url), { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), credentials: 'omit', referrerPolicy: 'no-referrer', headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' } });
  } catch (err) {
    if (signal.aborted) throw err;
    if ((err as Error)?.name === 'TimeoutError') throw new ReaderError('The site took too long to respond.');
    throw new ReaderError(`${url.host} doesn't allow other web apps to read its pages (it sends no CORS permission), or it can't be reached. Reader mode only works for sites that allow cross-origin reads — use the normal view or open the page in a new tab.`);
  }
  if (!res.ok) throw new ReaderError(`The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
  const type = res.headers.get('content-type') ?? '';
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new ReaderError('This page is too large for Reader mode.');
  const text = (await res.text()).slice(0, MAX_BYTES);
  if (/^text\/plain/i.test(type)) {
    return { title: url.pathname.split('/').pop() || url.host, site: url.host, words: countWords(text), body: h('article', null, h('pre', { class: 'br-plain' }, text)) };
  }
  if (type && !/html|xml/i.test(type)) throw new ReaderError(`This address is not a web page (${type.split(';')[0]}).`);

  const doc = new DOMParser().parseFromString(text, 'text/html');
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  const base = safeUrl(baseHref ?? '', url.href) ?? url;
  const meta = (sel: string) => doc.querySelector<HTMLMetaElement>(sel)?.content?.trim();
  const title = meta('meta[property="og:title"]') || doc.title.trim() || doc.querySelector('h1')?.textContent?.trim() || url.host;
  const site = meta('meta[property="og:site_name"]') || url.host;

  for (const el of doc.querySelectorAll(JUNK)) el.remove();
  for (const el of doc.querySelectorAll('header, [class], [id]')) {
    const name = `${el.getAttribute('class') ?? ''} ${el.id}`;
    const isHeader = el.tagName === 'HEADER' && !el.closest('article, main');
    if ((isHeader || JUNK_NAME.test(name)) && !el.querySelector('article, main') && el !== doc.body && el !== doc.documentElement) el.remove();
  }

  const root = pickRoot(doc);
  const ctx = { base, navigate, nodes: 0 };
  const body = h('article', null);
  convertChildren(root, body, ctx, 0);
  // Drop a leading heading that just repeats the title.
  const first = body.firstElementChild;
  if (first && /^H[1-3]$/.test(first.tagName) && first.textContent?.trim() === title) first.remove();
  const words = countWords(body.textContent ?? '');
  if (words < 20 && !body.querySelector('img')) throw new ReaderError('Reader mode could not find readable content on this page.');
  return { title, site, words, body };
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function safeUrl(href: string, base: string | URL): URL | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function textScore(el: Element): number {
  let n = 0;
  for (const p of el.querySelectorAll('p, pre, li, blockquote, td, dd')) n += p.textContent?.length ?? 0;
  return n || (el.textContent?.length ?? 0) * 0.2;
}

/** Prefer <article>/<main>; otherwise descend while one child holds most of the text. */
function pickRoot(doc: Document): Element {
  const total = textScore(doc.body);
  for (const sel of ['article', 'main, [role=main]']) {
    const best = [...doc.querySelectorAll(sel)].map((el) => [el, textScore(el)] as const).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= total * 0.4) return best[0];
  }
  let node: Element = doc.body;
  for (;;) {
    const score = textScore(node);
    const next = [...node.children].find((c) => textScore(c) >= score * 0.7);
    if (!next || score < 200) return node;
    node = next;
  }
}

interface Ctx {
  base: URL;
  navigate: (url: string) => void;
  nodes: number;
}

const MAP: Record<string, keyof HTMLElementTagNameMap> = {
  p: 'p', h1: 'h2', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd',
  blockquote: 'blockquote', figure: 'figure', figcaption: 'figcaption',
  em: 'em', i: 'em', cite: 'cite', strong: 'strong', b: 'strong', u: 'u', s: 's', del: 'del', ins: 'ins',
  mark: 'mark', small: 'small', sup: 'sup', sub: 'sub', q: 'q', abbr: 'abbr', kbd: 'kbd', samp: 'samp', var: 'var',
  table: 'table', caption: 'caption', thead: 'thead', tbody: 'tbody', tfoot: 'tfoot', tr: 'tr', th: 'th', td: 'td',
};

function convertChildren(src: Node, out: Node, ctx: Ctx, depth: number): void {
  for (const child of src.childNodes) {
    const n = convert(child, ctx, depth + 1);
    if (n) out.appendChild(n);
  }
}

function convert(node: Node, ctx: Ctx, depth: number): Node | null {
  if (++ctx.nodes > MAX_NODES) return null;
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (depth > 60) return document.createTextNode(el.textContent ?? '');

  switch (tag) {
    case 'br':
      return h('br');
    case 'hr':
      return h('hr');
    case 'pre':
      return h('pre', null, h('code', null, el.textContent ?? ''));
    case 'code':
    case 'tt':
      return h('code', null, el.textContent ?? '');
    case 'img':
      return image(el, ctx);
    case 'a':
      return link(el, ctx, depth);
  }

  const mapped = MAP[tag];
  if (!mapped) {
    // Unknown wrappers (div, section, span, picture…) are unwrapped.
    const frag = document.createDocumentFragment();
    convertChildren(el, frag, ctx, depth);
    return frag;
  }
  const out = h(mapped);
  if (tag === 'ol') {
    const start = Number(el.getAttribute('start'));
    if (Number.isInteger(start)) (out as HTMLOListElement).start = start;
  }
  if (tag === 'abbr' && el.getAttribute('title')) out.title = el.getAttribute('title')!;
  convertChildren(el, out, ctx, depth);
  if ((tag === 'p' || /^h\d$/.test(tag) || tag === 'li') && !out.textContent?.trim() && !out.querySelector('img')) return null;
  return tag === 'table' ? h('div', { class: 'br-table' }, out) : out;
}

function image(el: Element, ctx: Ctx): Node | null {
  const raw = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0] || '';
  const src = safeUrl(raw, ctx.base);
  if (!src) return null;
  const w = Number(el.getAttribute('width'));
  if (w > 0 && w < 4) return null; // tracking pixels
  return h('img', { src: src.href, alt: el.getAttribute('alt') ?? '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' });
}

function link(el: Element, ctx: Ctx, depth: number): Node {
  const raw = el.getAttribute('href') ?? '';
  const url = raw.startsWith('#') ? null : safeUrl(raw, ctx.base);
  const frag = document.createDocumentFragment();
  convertChildren(el, frag, ctx, depth);
  if (!url) return frag;
  const href = url.href;
  return h(
    'a',
    {
      href,
      rel: 'noopener noreferrer',
      title: href,
      onclick: (e: MouseEvent) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // let the browser open a real tab
        e.preventDefault();
        ctx.navigate(href);
      },
    },
    frag,
  );
}
