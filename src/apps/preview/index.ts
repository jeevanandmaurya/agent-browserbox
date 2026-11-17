import { basename, dirname, isInside, resolve } from '@/kernel/vfs/path';
import type { AppModule } from '@/ui/apps';
import { debounce, fmtBytes, h } from '@/ui/dom';
import { renderMarkdown } from '../editor/markdown';
import { errMessage, isTextLike, kindOf, looksBinary, mimeOf, type FileKind } from '../files/filetypes';
import { buildSiteDoc, NAV_MESSAGE, resolveRef } from './inline';
import { loader } from '@/ui/icons';
import { mountDev } from './dev';
import { hexView, htmlFrame, ImageView, textView } from './views';
import './style.css';

const HOME = '/home/user';
const EDITABLE: FileKind[] = ['text', 'code', 'markdown', 'html', 'svg'];

const app: AppModule = {
  mount(ctx) {
    // A dev server's app: a different view with an address bar and a console.
    if (ctx.args.dev !== undefined) return mountDev(ctx, Number(ctx.args.dev));
    const fs = ctx.os.fs;
    const html = typeof ctx.args.html === 'string' ? ctx.args.html : null;
    let path = typeof ctx.args.path === 'string' && ctx.args.path ? resolve(HOME, ctx.args.path) : null;
    const titleArg = typeof ctx.args.title === 'string' && ctx.args.title ? ctx.args.title : null;
    // Multi-page sites may navigate within the folder of the first page opened.
    let siteRoot = path ? dirname(path) : '/';
    const history: string[] = [];
    let urls: string[] = [];
    let frame: HTMLIFrameElement | null = null;
    let image: ImageView | null = null;
    let generation = 0;

    const btn = (label: string, text: string, fn: () => void, extra: Record<string, unknown> = {}) =>
      h('button', { class: 'btn small', title: label, 'aria-label': label, onclick: fn, ...extra }, text);
    const label = h('span', { class: 'pv-title' });
    const backBtn = btn('Back', '←', () => void back(), { hidden: true, class: 'btn small ghost' });
    const zoomLabel = h('span', { class: 'pv-zoom-label muted', 'aria-live': 'polite' });
    const zoom = h(
      'div',
      { class: 'pv-zoom', role: 'group', 'aria-label': 'Zoom', hidden: true },
      btn('Zoom out (−)', '−', () => image?.step(-1)),
      zoomLabel,
      btn('Zoom in (+)', '+', () => image?.step(1)),
      btn('Fit to window (0)', 'Fit', () => image?.set(null)),
      btn('Actual size (1)', '1:1', () => image?.set(1)),
    );
    const editBtn = btn('Open in Editor', 'Edit', () => path && ctx.launch('editor', { path }), { hidden: true });
    const body = h('div', { class: 'pv-body fill' });
    ctx.root.append(h('div', { class: 'toolbar pv-toolbar', role: 'toolbar', 'aria-label': 'Preview' }, backBtn, label, zoom, btn('Reload', '⟳', () => void render()), editBtn), body);

    const blob = (bytes: Uint8Array, type: string) => {
      const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      urls.push(u);
      return u;
    };
    const revokeAll = () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
    };
    const empty = (msg: string, ...actions: HTMLElement[]) => h('div', { class: 'empty' }, h('div', { class: 'col', style: 'align-items:center' }, h('p', null, msg), actions.length && h('div', { class: 'row' }, actions)));

    function setChrome(): void {
      const name = titleArg && !history.length ? titleArg : path ? basename(path) : 'Preview';
      ctx.win.setTitle(`${name} — Preview`);
      label.textContent = path ?? titleArg ?? 'Untitled';
      label.title = path ?? '';
      backBtn.hidden = !history.length;
      editBtn.hidden = !path || !EDITABLE.includes(kindOf(path));
    }

    function navigate(target: string): void {
      if (!path || target === path) return;
      history.push(path);
      path = target;
      void render();
    }
    function back(): void {
      const prev = history.pop();
      if (!prev) return;
      path = prev;
      void render();
    }

    async function view(p: string, gen: number): Promise<HTMLElement> {
      const st = await fs.stat(p);
      if (!st) return empty(`${p} doesn't exist (yet). This view reloads when it appears.`);
      if (st.kind === 'dir') return empty(`${p} is a folder.`, btn('Open in Files', 'Open in Files', () => ctx.launch('files', { path: p })));
      const bytes = await fs.readFile(p);
      if (gen !== generation) return h('div');
      const name = basename(p);
      switch (kindOf(name)) {
        case 'html': {
          const doc = await buildSiteDoc(fs, p, new TextDecoder().decode(bytes), siteRoot);
          return (frame = htmlFrame(doc, name));
        }
        case 'image':
        case 'svg': {
          // SVG goes through <img> too, which never runs its scripts.
          image = new ImageView(blob(bytes, mimeOf(name)), name);
          image.onChange = () => (zoomLabel.textContent = `${Math.round((image?.scale ?? 1) * 100)}%`);
          zoom.hidden = false;
          return image.el;
        }
        case 'audio':
          return h('div', { class: 'pv-media' }, h('audio', { controls: true, src: blob(bytes, mimeOf(name)), 'aria-label': name }));
        case 'video':
          return h('div', { class: 'pv-media' }, h('video', { controls: true, playsInline: true, src: blob(bytes, mimeOf(name)), 'aria-label': name }));
        case 'pdf': {
          // The browser's PDF viewer refuses to run in a sandboxed frame; the blob is typed
          // application/pdf so it can only ever be handled by that viewer.
          const u = blob(bytes, 'application/pdf');
          return h('div', { class: 'pv-pdf' }, h('p', { class: 'pv-note' }, h('a', { href: u, target: '_blank', rel: 'noopener' }, 'Open PDF in a new tab'), ` · ${fmtBytes(bytes.length)}`), h('iframe', { class: 'pv-frame', src: u, title: name }));
        }
        case 'markdown': {
          const base = dirname(p);
          const md = h('article', { class: 'md pv-md' });
          md.append(
            renderMarkdown(new TextDecoder().decode(bytes), {
              onLink: (href) => {
                const t = resolve(base, decodeURI(href.split('#')[0]!));
                if (isTextLike(t) && kindOf(t) !== 'markdown') ctx.launch('editor', { path: t });
                else navigate(t);
              },
              resolveImage: (src, img) => {
                void fs.readFile(resolve(base, decodeURI(src))).then(
                  (b) => gen === generation && (img.src = blob(b, mimeOf(src))),
                  () => undefined,
                );
              },
            }),
          );
          return h('div', { class: 'pv-scroll' }, md);
        }
        default:
          return looksBinary(bytes) ? hexView(bytes) : textView(bytes);
      }
    }

    async function render(): Promise<void> {
      const gen = ++generation;
      // Keep the old view (and its blob URLs) on screen until the new one is ready.
      const stale = urls;
      urls = [];
      frame = null;
      image = null;
      zoom.hidden = true;
      setChrome();
      if (path && !isInside(siteRoot, path)) siteRoot = dirname(path);
      if (!path) {
        body.replaceChildren(html !== null ? (frame = htmlFrame(html, titleArg ?? 'HTML preview')) : empty('Nothing to preview. Open a file from Files.'));
        return;
      }
      if (!body.firstChild) body.append(h('div', { class: 'app-loading' }, loader(28)));
      let el: HTMLElement;
      try {
        el = await view(path, gen);
      } catch (err) {
        el = empty(`Could not open ${path}: ${errMessage(err)}`, btn('Retry', 'Retry', () => void render()));
      }
      stale.forEach((u) => URL.revokeObjectURL(u));
      if (gen !== generation || ctx.win.closed) return;
      body.replaceChildren(el);
    }

    // Links clicked inside a sandboxed page arrive as messages from its frame.
    const onMessage = (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow || e.data?.type !== NAV_MESSAGE || !path) return;
      const target = resolveRef(siteRoot, dirname(path), String(e.data.href));
      if (target) navigate(target);
      else ctx.os.notify({ title: 'Link blocked', body: `Preview only follows links inside ${siteRoot}.`, level: 'warn' });
    };
    addEventListener('message', onMessage);

    const reload = debounce(() => void render(), 300);
    ctx.on('fs:change', (c) => {
      if (!path || c.type === 'mount') return;
      // HTML pages reload when any file of their site changes (CSS, scripts, images).
      const watched = kindOf(path) === 'html' ? isInside(siteRoot, c.path) : c.path === path;
      if (watched || isInside(c.path, path)) reload();
    });

    void render();
    return () => {
      generation++;
      removeEventListener('message', onMessage);
      revokeAll();
    };
  },
};

export default app;
