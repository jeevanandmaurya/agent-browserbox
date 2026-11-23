import { h } from '@/ui/dom';
import { icon } from '@/ui/icons';
import { renderMarkdown } from '../editor/markdown';
import './style.css';

/** The documentation: one Markdown file per topic, in order (NN-id.md, starting with "# Title"). */
const raw = import.meta.glob('./docs/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export interface Topic {
  id: string;
  title: string;
  body: string;
}

export const TOPICS: Topic[] = Object.entries(raw)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, text]) => ({ id: /\d+-([\w-]+)\.md$/.exec(path)![1]!, title: /^# (.+)$/m.exec(text)![1]!, body: text.replace(/^# .+\n+/, '') }));

/** Plain text of a topic, for search. */
const plain = (t: Topic) => t.body.replace(/[`*_#>|[\]()-]+/g, ' ').replace(/\s+/g, ' ');

export interface DocsOptions {
  initial?: string;
  /** Called when the reader opens a topic (to keep the address in step). */
  onNavigate?: (id: string) => void;
  /** Shown as "Open in new tab" when the docs are inside the app. */
  pageUrl?: string;
  /** Text under the title (e.g. the version). */
  footer?: string;
}

/**
 * The documentation view: topics on the left (a list, then a page, on narrow
 * screens), the topic on the right, and a search over all of them.
 */
export function docsView(o: DocsOptions = {}): HTMLElement & { show(id: string): void } {
  const search = h('input', { class: 'input dc-search', type: 'search', placeholder: 'Search the docs', 'aria-label': 'Search the docs' });
  const nav = h('nav', { class: 'dc-nav', 'aria-label': 'Topics' });
  const article = h('article', { class: 'dc-article md', tabindex: -1 });
  const back = h('button', { class: 'dc-back', type: 'button', onclick: () => (layout.dataset.view = 'list') }, icon('arrowLeft', 16), 'Topics');
  const main = h('main', { class: 'dc-main' }, back, article);
  const side = h(
    'aside',
    { class: 'dc-side' },
    h('div', { class: 'dc-brand' }, h('strong', null, 'BrowserBox docs'), o.pageUrl ? h('a', { class: 'dc-ext', href: o.pageUrl, target: '_blank', rel: 'noopener', title: 'Open the docs in a new tab' }, icon('external', 14)) : null),
    search,
    nav,
    o.footer ? h('p', { class: 'dc-foot muted' }, o.footer) : null,
  );
  const layout = h('div', { class: 'dc', dataset: { view: o.initial ? 'topic' : 'list' } }, side, main);
  // The wrapper is the size container: the layout inside follows its width.
  const outer = h('div', { class: 'dc-wrap' }, layout) as unknown as HTMLElement & { show(id: string): void };
  let current = '';

  function links(): void {
    nav.replaceChildren(
      ...TOPICS.map((t) => h('button', { class: 'dc-link', type: 'button', 'aria-current': t.id === current ? 'page' : 'false', onclick: () => show(t.id) }, t.title, icon('chevron', 14))),
    );
  }

  function show(id: string, anchor?: string): void {
    const t = TOPICS.find((x) => x.id === id) ?? TOPICS[0]!;
    current = t.id;
    search.value = '';
    links();
    article.replaceChildren(
      h('h1', null, t.title),
      renderMarkdown(t.body, {
        // Links between topics: [Models](models) or [Models](models#heading).
        onLink: (href) => {
          const [to, hash] = href.replace(/^#/, '').split('#') as [string, string?];
          if (TOPICS.some((x) => x.id === to)) show(to, hash);
        },
      }),
    );
    layout.dataset.view = 'topic';
    article.scrollTop = 0;
    main.scrollTop = 0;
    if (anchor) [...article.querySelectorAll('h2, h3')].find((el) => el.textContent?.toLowerCase().replace(/\W+/g, '-').includes(anchor))?.scrollIntoView();
    o.onNavigate?.(t.id);
  }
  outer.show = (id) => show(id);

  function results(): void {
    const q = search.value.trim().toLowerCase();
    if (!q) return links();
    const hits = TOPICS.map((t) => {
      const text = plain(t);
      const at = text.toLowerCase().indexOf(q);
      const titleHit = t.title.toLowerCase().includes(q);
      return { t, at, score: titleHit ? 2 : at >= 0 ? 1 : 0, snippet: at >= 0 ? text.slice(Math.max(0, at - 40), at + 80).trim() : '' };
    })
      .filter((r) => r.score)
      .sort((a, b) => b.score - a.score);
    nav.replaceChildren(
      ...(hits.length
        ? hits.map((r) =>
            h(
              'button',
              { class: 'dc-link dc-hit', type: 'button', onclick: () => show(r.t.id) },
              h('span', null, h('strong', null, r.t.title), r.snippet ? h('span', { class: 'dc-snippet' }, `…${r.snippet}…`) : null),
            ),
          )
        : [h('p', { class: 'dc-none muted' }, 'Nothing matches. Try other words, or ask the agent.')]),
    );
  }
  search.addEventListener('input', results);
  search.addEventListener('keydown', (e) => e.key === 'Enter' && (nav.querySelector<HTMLElement>('.dc-link')?.click(), e.preventDefault()));

  if (o.initial) show(o.initial);
  else {
    links();
    show(TOPICS[0]!.id);
    layout.dataset.view = 'list';
  }
  return outer;
}
