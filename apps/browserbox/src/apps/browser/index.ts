import { embeddable } from '@jeevanand/agent-browserbox-runtime/client';
import './style.css';
import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';
import { isBookmarkKey, loadBookmarks, saveBookmarks, toggleBookmark } from './bookmarks';
import { loadArticle, ReaderError } from './reader';
import { hostOf, isMixedContent, isSameOrigin, knownToBlock, resolveInput } from './url';
import { notice, startPage } from './views';

const app: AppModule = {
  mount(ctx) {
    const { os } = ctx;
    // Our own history: cross-origin frame history is unreadable. '' is the start page.
    const history: string[] = [];
    let index = -1;
    let reader = false;
    let load: AbortController | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    /** URLs the user chose to frame despite a warning. */
    const forced = new Set<string>();

    const iconBtn = (label: string, text: string, onclick: () => void) => h('button', { class: 'btn ghost small br-icon', 'aria-label': label, title: label, onclick }, text);
    const backBtn = iconBtn('Back (Alt+←)', '←', () => go(-1));
    const fwdBtn = iconBtn('Forward (Alt+→)', '→', () => go(1));
    const reloadBtn = iconBtn('Reload (F5)', '⟳', () => render());
    const homeBtn = iconBtn('Start page', '⌂', () => navigate(''));
    const starBtn = iconBtn('Bookmark this page (Ctrl+D)', '☆', () => toggleStar());
    const readerBtn = h('button', { class: 'btn small', 'aria-pressed': 'false', title: 'Show a clean, text-only version of the page', onclick: () => setReader(!reader) }, 'Reader');
    const extBtn = h('button', { class: 'btn small', title: 'Open the page in a real browser tab', onclick: () => openExternal() }, 'Open in new tab ↗');
    const urlInput = h('input', {
      class: 'input br-url',
      type: 'text',
      inputMode: 'url',
      enterKeyHint: 'go',
      autocomplete: 'off',
      autocapitalize: 'off',
      placeholder: 'Search or enter address',
      'aria-label': 'Address',
      onfocus: () => urlInput.select(),
    });
    urlInput.spellcheck = false;
    const urlForm = h(
      'form',
      {
        class: 'br-urlform',
        role: 'search',
        onsubmit: (e: Event) => {
          e.preventDefault();
          navigate(urlInput.value);
          urlInput.blur();
        },
      },
      urlInput,
    );
    const bar = h('div', { class: 'br-progress', hidden: true, role: 'progressbar', 'aria-label': 'Loading' });
    const marks = h('nav', { class: 'br-marks', 'aria-label': 'Bookmarks bar' });
    const view = h('div', { class: 'br-view fill' });

    ctx.root.append(
      h('div', { class: 'toolbar br-toolbar' }, backBtn, fwdBtn, reloadBtn, homeBtn, urlForm, starBtn, readerBtn, extBtn),
      marks,
      h('div', { class: 'br-stage fill' }, bar, view),
    );

    const current = () => history[index] ?? '';

    function setBusy(on: boolean): void {
      bar.hidden = !on;
      clearTimeout(loadTimer);
      if (on) loadTimer = setTimeout(() => setBusy(false), 20000);
      const url = current();
      os.procs.update(ctx.proc.pid, { state: on ? 'running' : 'idle', detail: url ? hostOf(url) : 'start page' });
    }

    function navigate(input: string): void {
      const t = resolveInput(input);
      if (t.kind === 'vfs') return void openVfs(t.path);
      if (t.kind === 'error') return show(notice('Can’t open this address', t.reason), t.input);
      const url = t.kind === 'web' ? t.url : '';
      if (url && isSameOrigin(url)) {
        return show(notice('This page can’t be shown here', 'It belongs to BrowserBox’s own origin. Framing it with site permissions would give it access to this OS’s storage, so it is refused.', [{ label: 'Open in new tab ↗', run: () => openExternal(url) }]), url);
      }
      history.splice(index + 1);
      history.push(url);
      index = history.length - 1;
      render();
    }

    function go(delta: number): void {
      const next = index + delta;
      if (next < 0 || next >= history.length) return;
      index = next;
      render();
    }

    async function openVfs(path: string): Promise<void> {
      const st = await os.fs.stat(path).catch(() => null);
      if (!st) return os.notify({ title: 'File not found', body: path, level: 'warn' });
      if (st.kind === 'dir') return ctx.launch('files', { path });
      ctx.launch('preview', { path });
    }

    function openExternal(url = current()): void {
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
    }

    function setReader(on: boolean): void {
      reader = on;
      readerBtn.setAttribute('aria-pressed', String(on));
      readerBtn.classList.toggle('primary', on);
      if (current()) render();
    }

    function toggleStar(): void {
      const url = current();
      if (!url) return;
      const added = toggleBookmark(os, url, view.dataset.title || hostOf(url));
      os.notify({ title: added ? 'Bookmark added' : 'Bookmark removed', body: url, level: added ? 'ok' : 'info' });
    }

    function syncChrome(shownUrl: string): void {
      if (document.activeElement !== urlInput) urlInput.value = shownUrl;
      backBtn.disabled = index <= 0;
      fwdBtn.disabled = index >= history.length - 1;
      const url = current();
      const starred = !!url && loadBookmarks(os).some((b) => b.url === url);
      starBtn.textContent = starred ? '★' : '☆';
      starBtn.disabled = !url;
      starBtn.setAttribute('aria-pressed', String(starred));
      starBtn.classList.toggle('br-starred', starred);
      extBtn.disabled = !url;
      ctx.win.setTitle(url ? `Browser — ${view.dataset.title || hostOf(url)}` : 'Browser');
    }

    /** Shows a view without touching history (errors, refusals). */
    function show(el: HTMLElement, shownUrl: string): void {
      load?.abort();
      view.replaceChildren(el);
      view.dataset.title = '';
      setBusy(false);
      syncChrome(shownUrl);
    }

    function renderBookmarks(): void {
      const list = loadBookmarks(os);
      marks.hidden = list.length === 0;
      marks.replaceChildren(...list.map((b) => h('button', { class: 'btn ghost small br-mark', title: b.url, onclick: () => navigate(b.url) }, b.title)));
      if (!current() && view.querySelector('.br-start')) render();
      else syncChrome(current());
    }

    function render(): void {
      load?.abort();
      load = new AbortController();
      const url = current();
      view.dataset.title = '';
      if (!url) {
        view.replaceChildren(
          startPage(loadBookmarks(os), navigate, (u) => saveBookmarks(os, loadBookmarks(os).filter((b) => b.url !== u))),
        );
        setBusy(false);
      } else if (reader) void renderReader(url, load.signal);
      else renderFrame(url);
      syncChrome(url);
    }

    function renderFrame(url: string): void {
      const warn = !forced.has(url) && (isMixedContent(url) ? 'mixed' : knownToBlock(url) ? 'blocked' : null);
      if (warn) {
        view.replaceChildren(
          notice(
            warn === 'mixed' ? 'Insecure page' : `${hostOf(url)} refuses to be embedded`,
            warn === 'mixed'
              ? 'This is a plain http:// address. Browsers block insecure pages inside a secure (https) app, so it would stay blank here.'
              : 'This site tells browsers not to show it inside other pages, so it would stay blank here.',
            [
              { label: 'Open in new tab ↗', run: () => openExternal(url), primary: true },
              { label: 'Try Reader', run: () => setReader(true) },
              {
                label: 'Load anyway',
                run: () => {
                  forced.add(url);
                  render();
                },
              },
            ],
          ),
        );
        setBusy(false);
        return;
      }
      const frame = embeddable(h('iframe', { class: 'br-frame', title: `Web page: ${hostOf(url)}` }), url);
      // Sandbox must be set before src. allow-same-origin keeps the remote site's own
      // origin (cross-origin to us); same-origin URLs are refused in navigate().
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.addEventListener('load', () => setBusy(false), { once: true });
      frame.src = url;
      const hint = h(
        'div',
        { class: 'br-hint', role: 'note' },
        h('span', null, 'If this page stays blank, the site blocks embedding — try Reader or open it in a new tab.'),
        h('button', { class: 'btn ghost small', onclick: () => setReader(true) }, 'Reader'),
        h('button', { class: 'btn ghost small', onclick: () => openExternal(url) }, 'New tab ↗'),
      );
      view.replaceChildren(h('div', { class: 'br-framebox' }, frame, hint));
      setBusy(true);
    }

    async function renderReader(url: string, signal: AbortSignal): Promise<void> {
      view.replaceChildren(h('div', { class: 'empty' }, 'Loading reader view…'));
      setBusy(true);
      try {
        const a = await loadArticle(url, signal, navigate);
        if (signal.aborted) return;
        view.dataset.title = a.title;
        const minutes = Math.max(1, Math.round(a.words / 230));
        view.replaceChildren(
          h(
            'div',
            { class: 'br-reader', tabIndex: 0, 'aria-label': `Reader view: ${a.title}` },
            h('header', { class: 'br-reader-head' }, h('div', { class: 'muted' }, a.site), h('h1', null, a.title), h('div', { class: 'muted' }, `${minutes} min read · `, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'original ↗'))),
            a.body,
          ),
        );
      } catch (err) {
        if (signal.aborted) return;
        const text = err instanceof ReaderError ? err.message : 'The page could not be read.';
        if (!(err instanceof ReaderError)) console.warn('[browser] reader failed', err);
        view.replaceChildren(
          notice('Reader view unavailable', text, [
            { label: 'Open in new tab ↗', run: () => openExternal(url), primary: true },
            { label: 'Show normal view', run: () => setReader(false) },
          ]),
        );
      }
      setBusy(false);
      syncChrome(url);
    }

    ctx.root.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && e.key === 'ArrowLeft') go(-1);
      else if (e.altKey && e.key === 'ArrowRight') go(1);
      else if (mod && e.key.toLowerCase() === 'l') urlInput.focus();
      else if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) render(); // also stops the whole OS from reloading
      else if (mod && e.key.toLowerCase() === 'd') toggleStar();
      else return;
      e.preventDefault();
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        urlInput.value = current();
        urlInput.blur();
      }
    });
    ctx.on('settings:change', ({ key }) => {
      if (isBookmarkKey(key)) renderBookmarks();
    });

    renderBookmarks();
    navigate(typeof ctx.args.url === 'string' ? ctx.args.url : '');
    if (index < 0 && !view.firstChild) navigate(''); // e.g. launched with a vfs: path
    if (!current()) urlInput.focus();

    return () => {
      load?.abort();
      clearTimeout(loadTimer);
    };
  },
};
export default app;
