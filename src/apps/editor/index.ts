import { basename, dirname, extname, isInside, resolve } from '@/kernel/vfs/path';
import type { AppContext, AppModule } from '@/ui/apps';
import { debounce, fmtBytes, h } from '@/ui/dom';
import { confirmDialog, promptDialog } from '@/ui/dialog';
import { errMessage, isTextLike, languageOf, looksBinary, mimeOf } from '../files/filetypes';
import { FindBar } from './find';
import { renderMarkdown } from './markdown';
import { RunPanel } from './run';
import { attachEditing, caretPos, Gutter, gotoLine } from './textarea';
import './style.css';

const MAX_SIZE = 5 * 1024 * 1024;
const HOME = '/home/user';
const dec = new TextDecoder();

function isReadOnly(ctx: AppContext, path: string): boolean {
  // mounts() is sorted longest-first, so the first match is the owning mount.
  return ctx.os.fs.mounts().find((m) => isInside(m.point, path))?.fs.readonly ?? false;
}

const app: AppModule = {
  mount(ctx) {
    const fs = ctx.os.fs;
    let path: string | null = null;
    let saved = '';
    let dirty = false;
    let readonly = false;

    const ta = h('textarea', { class: 'code-input', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Text editor' });
    ta.setAttribute('autocorrect', 'off');
    const gutter = new Gutter();
    const find = new FindBar(ta);
    const run = new RunPanel(ctx);
    const mdPane = h('div', { class: 'md-preview md', hidden: true, tabindex: 0, 'aria-label': 'Markdown preview' });
    const banner = h('div', { class: 'banner', role: 'status', hidden: true });
    const sb = {
      msg: h('span', { class: 'sb-msg' }),
      pos: h('span', null, 'Ln 1, Col 1'),
      len: h('span', { class: 'sb-len' }),
      lang: h('span', null, 'Plain Text'),
      ro: h('span', { class: 'badge warn', hidden: true }, 'read-only'),
    };

    const lang = () => (path ? languageOf(path) : 'Plain Text');
    const ext = () => (path ? extname(path) : '');
    const name = () => (path ? basename(path) : 'Untitled');

    // ── Toolbar ────────────────────────────────────────────────────────────
    const tb = (label: string, text: string, fn: () => void, extra: Record<string, unknown> = {}) =>
      h('button', { class: 'btn small', title: label, 'aria-label': label, onclick: fn, ...extra }, text);
    const saveBtn = tb('Save (Ctrl+S)', 'Save', () => void save());
    const wrapBtn = tb('Word wrap (Alt+Z)', 'Wrap', () => setWrap(ta.wrap === 'off'), { 'aria-pressed': 'false' });
    const mdBtn = tb('Toggle Markdown preview', 'Preview', () => toggleMd(), { 'aria-pressed': 'false', hidden: true });
    const runBtn = tb('Run (Ctrl+Enter)', 'Run', () => runBuffer(), { hidden: true, class: 'btn small primary' });
    const htmlBtn = tb('Save and open in Preview', 'Preview', () => void previewHtml(), { hidden: true });
    const toolbar = h(
      'div',
      { class: 'toolbar editor-toolbar', role: 'toolbar', 'aria-label': 'Editor' },
      tb('New file', 'New', () => void newBuffer()),
      tb('Open file (Ctrl+O)', 'Open', () => void openPrompt()),
      saveBtn,
      tb('Save as (Ctrl+Shift+S)', 'Save as', () => void saveAs()),
      h('span', { class: 'sep' }),
      tb('Find and replace (Ctrl+F)', 'Find', () => find.open()),
      tb('Go to line (Ctrl+G)', 'Go to', () => void goto()),
      wrapBtn,
      h('span', { class: 'spacer' }),
      mdBtn,
      htmlBtn,
      runBtn,
    );

    const codePane = h('div', { class: 'code' }, gutter.el, ta);
    const main = h('div', { class: 'editor-main fill' }, codePane, mdPane);
    ctx.root.append(toolbar, find.el, banner, main, run.el, h('div', { class: 'statusbar' }, sb.msg, sb.ro, sb.pos, sb.len, sb.lang, h('span', { class: 'sb-enc' }, 'UTF-8')));

    // ── State & chrome ─────────────────────────────────────────────────────
    function updateTitle(): void {
      ctx.win.setTitle(`${dirty ? '● ' : ''}${name()} — Editor`);
    }

    function setMsg(text: string, level: '' | 'warn' | 'err' = ''): void {
      sb.msg.textContent = text;
      sb.msg.className = `sb-msg ${level}`;
    }

    function showBanner(text: string, ...actions: HTMLElement[]): void {
      banner.replaceChildren(h('span', null, text), ...actions, h('button', { class: 'btn small ghost', 'aria-label': 'Dismiss', onclick: () => (banner.hidden = true) }, '✕'));
      banner.hidden = false;
    }

    function refreshChrome(): void {
      readonly = path ? isReadOnly(ctx, path) : false;
      sb.ro.hidden = !readonly;
      saveBtn.disabled = readonly;
      sb.lang.textContent = lang();
      const e = ext();
      runBtn.hidden = !['js', 'mjs', 'cjs', 'py'].includes(e);
      htmlBtn.hidden = e !== 'html' && e !== 'htm';
      mdBtn.hidden = lang() !== 'Markdown';
      if (mdBtn.hidden && !mdPane.hidden) toggleMd(false);
      updateTitle();
    }

    const updateStatus = () => {
      const { line, col } = caretPos(ta.value, ta.selectionStart);
      const sel = ta.selectionEnd - ta.selectionStart;
      sb.pos.textContent = `Ln ${line}, Col ${col}${sel ? ` (${sel} selected)` : ''}`;
      sb.len.textContent = `${ta.value.length.toLocaleString()} chars`;
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), updateStatus()));
    };

    function onEdit(): void {
      const was = dirty;
      dirty = ta.value !== saved;
      if (was !== dirty) {
        updateTitle();
        setMsg(dirty ? 'Unsaved changes — closing the window will discard them' : '', dirty ? 'warn' : '');
      }
      gutter.update(ta.value);
      find.refresh();
      if (!mdPane.hidden) renderMd();
      schedule();
    }

    function setText(text: string, keepView = false): void {
      const { selectionStart: s, selectionEnd: e, scrollTop } = ta;
      ta.value = text;
      saved = text;
      dirty = false;
      if (keepView) {
        ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
        ta.scrollTop = scrollTop;
      } else {
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
        setWrap(lang() === 'Markdown' || lang() === 'Plain Text');
      }
      onEdit();
      gutter.sync(ta);
    }

    function setWrap(on: boolean): void {
      ta.wrap = on ? 'soft' : 'off';
      wrapBtn.setAttribute('aria-pressed', String(on));
      // Line numbers cannot follow soft-wrapped rows in a textarea, so the gutter hides.
      gutter.el.hidden = on;
    }

    // ── Markdown preview ───────────────────────────────────────────────────
    const images = new Map<string, Promise<string | null>>();
    const blobFor = (p: string) => {
      if (!images.has(p)) images.set(p, fs.readFile(p).then((b) => URL.createObjectURL(new Blob([b as BlobPart], { type: mimeOf(p) })), () => null));
      return images.get(p)!;
    };
    const renderMd = debounce(() => {
      const base = path ? dirname(path) : HOME;
      mdPane.replaceChildren(
        renderMarkdown(ta.value, {
          onLink: (href) => {
            const target = resolve(base, decodeURI(href.split('#')[0]!));
            ctx.launch(isTextLike(target) ? 'editor' : 'preview', { path: target });
          },
          resolveImage: (src, img) => void blobFor(resolve(base, decodeURI(src))).then((u) => u && (img.src = u)),
        }),
      );
    }, 150);
    /** Swaps between the text and its rendered Markdown, in the same space. */
    function toggleMd(on = mdPane.hidden): void {
      mdPane.hidden = !on;
      codePane.hidden = on;
      mdBtn.setAttribute('aria-pressed', String(on));
      mdBtn.textContent = on ? 'Edit' : 'Preview';
      if (on) {
        renderMd();
        mdPane.focus({ preventScroll: true });
      } else ta.focus({ preventScroll: true });
    }

    // ── File operations ────────────────────────────────────────────────────
    async function confirmDiscard(): Promise<boolean> {
      return !dirty || confirmDialog('Discard unsaved changes?', `${name()} has unsaved changes that will be lost.`, 'Discard', true);
    }

    async function load(p: string): Promise<boolean> {
      banner.hidden = true;
      try {
        const st = await fs.stat(p);
        if (st?.kind === 'dir') throw new Error(`${p} is a folder`);
        if (!st) {
          path = p;
          refreshChrome();
          setText('');
          setMsg('New file — it will be created when you save');
          return true;
        }
        const refuse = (why: string) => {
          showBanner(why, h('button', { class: 'btn small', onclick: () => ctx.launch('preview', { path: p }) }, 'Open in Preview'));
          ctx.os.notify({ title: `Can't open ${basename(p)}`, body: why, level: 'warn' });
          return false;
        };
        if (st.size > MAX_SIZE) return refuse(`${basename(p)} is ${fmtBytes(st.size)}; the editor opens files up to 5 MB.`);
        const bytes = await fs.readFile(p);
        if (bytes.length > MAX_SIZE) return refuse(`${basename(p)} is ${fmtBytes(bytes.length)}; the editor opens files up to 5 MB.`);
        if (looksBinary(bytes, Infinity)) return refuse(`${basename(p)} looks like a binary file, so it can't be edited as text.`);
        path = p;
        refreshChrome();
        setText(dec.decode(bytes));
        setMsg('');
        return true;
      } catch (err) {
        showBanner(`Could not open ${p}: ${errMessage(err)}`);
        ctx.os.notify({ title: 'Open failed', body: errMessage(err), level: 'error' });
        return false;
      }
    }

    async function save(): Promise<boolean> {
      if (!path) return saveAs();
      if (readonly) {
        ctx.os.notify({ title: 'Read-only file', body: 'Use Save as to keep a copy elsewhere.', level: 'warn' });
        return false;
      }
      try {
        const text = ta.value;
        await fs.writeFile(path, text);
        saved = text;
        onEdit();
        setMsg(`Saved ${new Date().toLocaleTimeString()}`);
        banner.hidden = true;
        return true;
      } catch (err) {
        ctx.os.notify({ title: `Could not save ${name()}`, body: errMessage(err), level: 'error' });
        setMsg('Save failed', 'err');
        return false;
      }
    }

    async function saveAs(): Promise<boolean> {
      const base = path ? dirname(path) : HOME;
      const input = await promptDialog('Save as', 'Path', path ?? `${base}/untitled.txt`);
      if (!input?.trim()) return false;
      const target = resolve(base, input.trim());
      const st = await fs.stat(target).catch(() => null);
      if (st?.kind === 'dir') {
        ctx.os.notify({ title: `${target} is a folder`, level: 'error' });
        return false;
      }
      if (st && target !== path && !(await confirmDialog('Replace file?', `${target} already exists. Replace it?`, 'Replace', true))) return false;
      const prev = path;
      path = target;
      refreshChrome();
      if (await save()) return true;
      path = prev;
      refreshChrome();
      return false;
    }

    async function openPrompt(): Promise<void> {
      if (!(await confirmDiscard())) return;
      const base = path ? dirname(path) : HOME;
      const input = await promptDialog('Open file', 'Path', `${base === '/' ? '' : base}/`);
      if (input?.trim()) await load(resolve(base, input.trim()));
    }

    async function newBuffer(): Promise<void> {
      if (!(await confirmDiscard())) return;
      path = null;
      banner.hidden = true;
      refreshChrome();
      setText('');
      setMsg('');
      ta.focus();
    }

    async function goto(): Promise<void> {
      const total = ta.value.split('\n').length;
      const v = await promptDialog('Go to line', `Line number (1–${total})`, String(caretPos(ta.value, ta.selectionStart).line));
      const n = Number.parseInt(v ?? '', 10);
      if (Number.isFinite(n)) gotoLine(ta, Math.min(Math.max(1, n), total));
    }

    function runBuffer(): void {
      const e = ext();
      if (run.running || !['js', 'mjs', 'cjs', 'py'].includes(e)) return;
      void run.run(e === 'py' ? 'py' : 'js', ta.value, path ? dirname(path) : HOME);
    }

    async function previewHtml(): Promise<void> {
      if (!path || (dirty && !(await save()))) return;
      ctx.launch('preview', { path });
    }

    // ── Events ─────────────────────────────────────────────────────────────
    attachEditing(ta, lang);
    ta.addEventListener('input', onEdit);
    ta.addEventListener('scroll', () => gutter.sync(ta), { passive: true });
    for (const ev of ['keyup', 'pointerup', 'select', 'focus']) ta.addEventListener(ev, schedule);

    ctx.root.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const act = (fn: () => unknown) => {
        e.preventDefault();
        fn();
      };
      if (mod && k === 's') act(() => void (e.shiftKey ? saveAs() : save()));
      else if (mod && (k === 'f' || k === 'h')) act(() => find.open());
      else if (mod && k === 'g') act(() => void goto());
      else if (mod && k === 'o') act(() => void openPrompt());
      else if (mod && k === 'enter') act(runBuffer);
      else if (e.altKey && k === 'z') act(() => setWrap(ta.wrap === 'off'));
      else if (e.key === 'F3') act(() => (find.isOpen ? find.next(e.shiftKey ? -1 : 1) : find.open()));
    });

    // Reload when the file changes on disk; the debounce lets our own saves settle first.
    const onDiskChange = debounce(async (type: string) => {
      if (!path || ctx.win.closed) return;
      const p = path;
      if (type === 'remove') return setMsg('The file was deleted on disk — save to recreate it', 'warn');
      let text: string;
      try {
        text = await fs.readText(p);
      } catch {
        return;
      }
      if (p !== path || text === ta.value) {
        if (text === ta.value && dirty) ((saved = text), onEdit());
        return;
      }
      if (!dirty) {
        setText(text, true);
        setMsg('Reloaded — the file changed on disk');
      } else if (text !== saved) {
        showBanner('This file changed on disk. Saving will overwrite those changes.', h('button', { class: 'btn small', onclick: () => void ((banner.hidden = true), setText(text, true)) }, 'Reload from disk'));
      }
    }, 250);
    ctx.on('fs:change', (c) => {
      if (path && c.path === path && c.type !== 'mount') onDiskChange(c.type);
    });

    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    addEventListener('beforeunload', beforeUnload);

    // ── Start ──────────────────────────────────────────────────────────────
    refreshChrome();
    setText('');
    const initial = typeof ctx.args.path === 'string' && ctx.args.path ? resolve(HOME, ctx.args.path) : null;
    void (initial ? load(initial) : Promise.resolve(true)).then(() => ta.focus());

    return () => {
      removeEventListener('beforeunload', beforeUnload);
      cancelAnimationFrame(frame);
      for (const u of images.values()) void u.then((url) => url && URL.revokeObjectURL(url));
    };
  },
};

export default app;
