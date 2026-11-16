import { h } from '@/ui/dom';
import type { Bookmark } from './bookmarks';
import { hostOf } from './url';

export function startPage(bookmarks: Bookmark[], open: (url: string) => void, remove: (url: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'br-start' },
    h('h1', null, 'Browser'),
    h(
      'p',
      { class: 'muted' },
      'Pages open inside this window in a sandboxed frame. Many sites (search engines, GitHub, social networks) forbid being embedded in other pages, and the browser gives us no way to detect that, so they may simply stay blank. For those, use Reader mode — which works when a site allows cross-origin reads — or open the page in a real browser tab. Type a path such as /home/user/Welcome.md, or a vfs: URL, to open files from this OS.',
    ),
    bookmarks.length
      ? h(
          'ul',
          { class: 'br-tiles', 'aria-label': 'Bookmarks' },
          bookmarks.map((b) =>
            h(
              'li',
              { class: 'br-tile' },
              h(
                'button',
                { class: 'br-tile-open', onclick: () => open(b.url), title: b.url },
                h('span', { class: 'br-tile-icon', 'aria-hidden': 'true' }, (b.title.trim()[0] ?? '?').toUpperCase()),
                h('span', { class: 'br-tile-title' }, b.title),
                h('span', { class: 'br-tile-host muted' }, hostOf(b.url)),
              ),
              h('button', { class: 'br-tile-del btn ghost small', 'aria-label': `Remove bookmark ${b.title}`, title: 'Remove bookmark', onclick: () => remove(b.url) }, '×'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No bookmarks yet. Press ☆ in the toolbar to add the current page.'),
  );
}

export interface Action {
  label: string;
  run: () => void;
  primary?: boolean;
}

export function notice(title: string, text: string, actions: Action[] = []): HTMLElement {
  return h(
    'div',
    { class: 'empty br-notice' },
    h(
      'div',
      { class: 'col', style: 'max-width:480px;align-items:center' },
      h('h2', null, title),
      h('p', null, text),
      actions.length ? h('div', { class: 'row', style: 'flex-wrap:wrap;justify-content:center' }, actions.map((a) => h('button', { class: `btn${a.primary ? ' primary' : ''}`, onclick: a.run }, a.label))) : null,
    ),
  );
}
