import { basename, dirname, isInside, join, normalize, resolve } from '@/client/index';
import type { Stat } from '@/client/index';
import type { AppModule } from '@/ui/apps';
import { confirmDialog, promptDialog } from '@/ui/dialog';
import { debounce, fmtBytes, h } from '@/ui/dom';
import { errMessage, isTextLike } from './filetypes';
import { closeMenu, openMenu, type MenuItem } from './menu';
import { checkName, download, droppedUploads, uniquePath, writeUploads, type Upload } from './ops';
import { FileTable } from './table';
import { icon, type IconName } from '@/ui/icons';
import './style.css';

const HOME = '/home/user';
const PLACES: Array<[IconName, string, string]> = [
  ['home', 'Home', HOME],
  ['spark', 'Agent', '/home/agent'],
  ['drive', 'Root', '/'],
  ['clock', 'Temp', '/tmp'],
  ['chip', 'Proc', '/proc'],
];

/** Shared by every Files window so you can copy in one and paste in another. */
const clipboard: { paths: string[]; cut: boolean } = { paths: [], cut: false };

const app: AppModule = {
  mount(ctx) {
    const fs = ctx.os.fs;
    let cwd = '';
    const back: string[] = [];
    const fwd: string[] = [];
    let navToken = 0;
    let busy = 0;

    const isMount = (p: string) => fs.mounts().some((m) => m.point === p && p !== '/');
    const readOnly = (p: string) => fs.mounts().find((m) => isInside(m.point, p))?.fs.readonly ?? false;
    const fail = (title: string, err: unknown) => ctx.os.notify({ title, body: errMessage(err), level: 'error' });

    // ── Chrome ─────────────────────────────────────────────────────────────
    const btn = (label: string, name: IconName, fn: () => void, text?: string) =>
      h('button', { class: 'btn small', title: label, 'aria-label': label, onclick: fn }, icon(name, 16), text && h('span', { class: 'lbl' }, text));
    const backBtn = btn('Back (Alt+←)', 'arrowLeft', () => void history(-1));
    const fwdBtn = btn('Forward (Alt+→)', 'arrowRight', () => void history(1));
    const upBtn = btn('Up one folder (Backspace)', 'arrowUp', () => void go(dirname(cwd)));
    const pathInput = h('input', { class: 'input mono path-input', 'aria-label': 'Folder path', spellcheck: false, autocapitalize: 'off' });
    const pathForm = h('form', { class: 'path-form', onsubmit: (e: Event) => (e.preventDefault(), void go(resolve(cwd, pathInput.value.trim() || cwd))) }, pathInput);
    pathInput.addEventListener('keydown', (e) => e.key === 'Escape' && ((pathInput.value = cwd), table.el.focus()));

    const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => void uploadPicked() });
    const act = {
      newFile: btn('New file', 'filePlus', () => void newItem('file'), 'File'),
      newDir: btn('New folder', 'folderPlus', () => void newItem('dir'), 'Folder'),
      upload: btn('Upload files', 'upload', () => fileInput.click(), 'Upload'),
      mount: btn('Mount a folder from this device', 'plug', () => void mountFolder(), 'Mount'),
      open: btn('Open (Enter)', 'external', () => openSelected(), 'Open'),
      copy: btn('Copy (Ctrl+C)', 'copy', () => toClipboard(false)),
      cut: btn('Cut (Ctrl+X)', 'scissors', () => toClipboard(true)),
      paste: btn('Paste (Ctrl+V)', 'clipboard', () => void paste()),
      rename: btn('Rename (F2)', 'edit', () => void rename()),
      download: btn('Download', 'download', () => void downloadSelected()),
      del: btn('Delete (Del)', 'trash', () => void remove()),
    };
    act.mount.hidden = !ctx.os.hasCap('fsaccess');

    const places = h('nav', { class: 'files-places', 'aria-label': 'Places' });
    const status = { count: h('span'), sel: h('span'), msg: h('span', { class: 'files-msg' }), store: h('span', { class: 'files-store' }) };
    const table = new FileTable({
      open: (e) => openEntry(e),
      menu: (x, y, onRow) => openMenu(ctx.root, x, y, onRow ? rowMenu() : bgMenu(), table.el),
      selectionChanged: () => updateChrome(),
    });
    const drop = h('div', { class: 'files-drop', 'aria-hidden': 'true' }, 'Drop to upload here');

    ctx.root.append(
      h('div', { class: 'toolbar files-nav' }, backBtn, fwdBtn, upBtn, pathForm, btn('Refresh', 'refresh', () => void refresh())),
      h('div', { class: 'toolbar files-actions', role: 'toolbar', 'aria-label': 'File actions' }, act.newFile, act.newDir, act.upload, act.mount, h('span', { class: 'sep' }), act.open, act.copy, act.cut, act.paste, act.rename, act.download, act.del),
      h('div', { class: 'files-body fill' }, places, h('div', { class: 'files-main' }, table.el, drop)),
      h('div', { class: 'statusbar' }, status.count, status.sel, status.msg, h('span', { class: 'spacer fill' }), status.store),
      fileInput,
    );

    function renderPlaces(): void {
      const mounts = fs.mounts().filter((m) => dirname(m.point) === '/mnt').map((m): [IconName, string, string] => ['plug', basename(m.point), m.point]);
      places.replaceChildren(
        ...[...PLACES, ...mounts].map(([name, label, p]) =>
          h('button', { class: 'place', title: p, 'aria-current': p === cwd ? 'page' : null, onclick: () => void go(p) }, icon(name, 16), h('span', null, label)),
        ),
      );
    }

    function updateChrome(): void {
      const sel = table.selection;
      const ro = readOnly(cwd);
      const files = sel.filter((s) => s.kind === 'file');
      backBtn.disabled = !back.length;
      fwdBtn.disabled = !fwd.length;
      upBtn.disabled = cwd === '/';
      for (const b of [act.newFile, act.newDir, act.upload]) b.disabled = ro;
      act.paste.disabled = ro || !clipboard.paths.length;
      act.open.disabled = !sel.length;
      act.copy.disabled = !sel.length;
      act.cut.disabled = act.del.disabled = ro || !sel.length;
      act.rename.disabled = ro || sel.length !== 1;
      act.download.disabled = !files.length;
      const n = table.entries.length;
      status.count.textContent = `${n} item${n === 1 ? '' : 's'}${ro ? ' · read-only' : ''}`;
      status.sel.textContent = sel.length ? `${sel.length} selected${files.length ? ` (${fmtBytes(files.reduce((a, s) => a + s.size, 0))})` : ''}` : '';
    }

    const updateStorage = debounce(async () => {
      const est = await navigator.storage?.estimate?.().catch(() => null);
      if (est?.quota) status.store.textContent = `${fmtBytes(est.usage ?? 0)} of ${fmtBytes(est.quota)} used`;
    }, 1500);

    async function withBusy<T>(msg: string, fn: () => Promise<T>): Promise<T> {
      busy++;
      status.msg.textContent = msg;
      try {
        return await fn();
      } finally {
        if (--busy === 0) status.msg.textContent = '';
      }
    }

    // ── Navigation ─────────────────────────────────────────────────────────
    async function go(target: string, mode: 'push' | 'none' = 'push', select: string[] = []): Promise<boolean> {
      const p = normalize(target);
      const token = ++navToken;
      let list: Stat[];
      try {
        const st = await fs.stat(p);
        if (!st) throw new Error(`${p} does not exist`);
        if (st.kind !== 'dir') {
          // Launched with a file path: show it in its folder rather than opening it.
          if (!cwd) return go(dirname(p), mode, [p]);
          openFile(p);
          pathInput.value = cwd;
          return false;
        }
        list = await fs.readdir(p);
      } catch (err) {
        if (token === navToken) pathInput.value = cwd;
        fail(`Can't open ${p}`, err);
        return false;
      }
      if (token !== navToken || ctx.win.closed) return false;
      if (mode === 'push' && cwd && p !== cwd) {
        back.push(cwd);
        fwd.length = 0;
      }
      const changed = p !== cwd;
      cwd = p;
      pathInput.value = p;
      ctx.win.setTitle(`${p === '/' ? '/' : basename(p)} — Files`);
      if (changed) table.selected.clear();
      table.set(list);
      if (select.length) table.select(select);
      renderPlaces();
      return true;
    }

    async function history(dir: -1 | 1): Promise<void> {
      const [from, to] = dir < 0 ? [back, fwd] : [fwd, back];
      const target = from.pop();
      if (!target) return;
      to.push(cwd);
      if (!(await go(target, 'none'))) {
        from.push(target);
        to.pop();
      }
      updateChrome();
    }

    async function refresh(select: string[] = []): Promise<void> {
      // If the folder vanished, fall back to the nearest ancestor that still exists.
      let p = cwd;
      while (p !== '/' && !(await fs.exists(p))) p = dirname(p);
      await go(p, 'none', select);
    }

    // ── Opening ────────────────────────────────────────────────────────────
    function openFile(p: string, inEditor = false): void {
      ctx.launch(inEditor || isTextLike(p) ? 'editor' : 'preview', { path: p });
    }
    function openEntry(e: Stat): void {
      if (e.kind === 'dir') void go(e.path);
      else openFile(e.path);
    }
    function openSelected(inEditor = false): void {
      const sel = table.selection;
      const dir = sel.find((s) => s.kind === 'dir');
      if (dir && sel.length === 1 && !inEditor) return void go(dir.path);
      sel.filter((s) => s.kind === 'file').slice(0, 12).forEach((s) => openFile(s.path, inEditor));
    }

    // ── Actions ────────────────────────────────────────────────────────────
    async function newItem(kind: 'file' | 'dir'): Promise<void> {
      const suggested = basename(await uniquePath(fs, cwd, kind === 'file' ? 'untitled.txt' : 'New folder'));
      const name = (await promptDialog(kind === 'file' ? 'New file' : 'New folder', 'Name', suggested))?.trim();
      if (name === undefined) return;
      const bad = checkName(name);
      if (bad) return ctx.os.notify({ title: bad, level: 'warn' });
      const p = join(cwd, name);
      try {
        if (await fs.exists(p)) throw new Error(`“${name}” already exists here.`);
        await (kind === 'file' ? fs.writeFile(p, '') : fs.mkdir(p));
        await refresh([p]);
        table.el.focus();
      } catch (err) {
        fail(`Could not create ${name}`, err);
      }
    }

    async function rename(): Promise<void> {
      const [s] = table.selection;
      if (!s || table.selected.size !== 1) return;
      if (isMount(s.path)) return ctx.os.notify({ title: 'Mount points cannot be renamed', level: 'warn' });
      const name = (await promptDialog('Rename', 'New name', s.name))?.trim();
      if (!name || name === s.name) return table.el.focus();
      const bad = checkName(name);
      if (bad) return ctx.os.notify({ title: bad, level: 'warn' });
      const to = join(dirname(s.path), name);
      try {
        // Case-only renames are allowed to "exist" already on case-insensitive backends.
        if (name.toLowerCase() !== s.name.toLowerCase() && (await fs.exists(to))) throw new Error(`“${name}” already exists here.`);
        await withBusy(`Renaming ${s.name}…`, () => fs.mv(s.path, to));
        await refresh([to]);
      } catch (err) {
        fail(`Could not rename ${s.name}`, err);
      }
      table.el.focus();
    }

    async function duplicate(): Promise<void> {
      const made: string[] = [];
      await withBusy('Duplicating…', async () => {
        for (const s of table.selection) {
          try {
            const to = await uniquePath(fs, dirname(s.path), s.name, 'copy');
            await fs.cp(s.path, to);
            made.push(to);
          } catch (err) {
            fail(`Could not duplicate ${s.name}`, err);
          }
        }
      });
      await refresh(made);
    }

    function toClipboard(cut: boolean): void {
      const sel = table.selection.filter((s) => !(cut && isMount(s.path)));
      if (!sel.length) return;
      clipboard.paths = sel.map((s) => s.path);
      clipboard.cut = cut;
      table.cut = new Set(cut ? clipboard.paths : []);
      table.repaint();
      status.msg.textContent = `${sel.length} item${sel.length === 1 ? '' : 's'} ${cut ? 'cut' : 'copied'}`;
    }

    async function paste(): Promise<void> {
      if (!clipboard.paths.length || readOnly(cwd)) return;
      const { paths, cut } = clipboard;
      const made: string[] = [];
      await withBusy(cut ? 'Moving…' : 'Copying…', async () => {
        for (const src of paths) {
          const name = basename(src);
          try {
            if (cut && dirname(src) === cwd) continue;
            if (isInside(src, cwd)) throw new Error('A folder cannot be pasted into itself.');
            const to = (await fs.exists(join(cwd, name))) ? await uniquePath(fs, cwd, name, cut ? 'number' : 'copy') : join(cwd, name);
            await (cut ? fs.mv(src, to) : fs.cp(src, to));
            made.push(to);
          } catch (err) {
            fail(`Could not ${cut ? 'move' : 'copy'} ${name}`, err);
          }
        }
      });
      if (cut) {
        clipboard.paths = [];
        table.cut = new Set();
      }
      await refresh(made);
    }

    async function remove(): Promise<void> {
      const sel = table.selection;
      if (!sel.length || readOnly(cwd)) return;
      const what = sel.length === 1 ? `“${sel[0]!.name}”` : `${sel.length} items`;
      const hasDir = sel.some((s) => s.kind === 'dir');
      if (!(await confirmDialog(`Delete ${what}?`, `${hasDir ? 'Folders are deleted with everything inside them. ' : ''}This cannot be undone.`, 'Delete', true))) return table.el.focus();
      await withBusy('Deleting…', async () => {
        for (const s of sel) await fs.rm(s.path, { recursive: true }).catch((err) => fail(`Could not delete ${s.name}`, err));
      });
      await refresh();
      table.el.focus();
    }

    async function downloadSelected(): Promise<void> {
      for (const s of table.selection.filter((x) => x.kind === 'file')) {
        await download(fs, s.path, ctx.root).catch((err) => fail(`Could not download ${s.name}`, err));
      }
    }

    async function upload(items: Upload[]): Promise<void> {
      if (!items.length) return;
      if (readOnly(cwd)) return ctx.os.notify({ title: 'This folder is read-only', level: 'warn' });
      const dir = cwd;
      try {
        const n = await withBusy(`Uploading ${items.length} file${items.length === 1 ? '' : 's'}…`, () => writeUploads(fs, dir, items, ctx.proc.signal));
        ctx.os.notify({ title: `Uploaded ${n} file${n === 1 ? '' : 's'}`, body: dir, level: 'ok' });
      } catch (err) {
        if (!ctx.proc.signal.aborted) fail('Upload failed', err);
      }
      if (cwd === dir) await refresh();
    }

    async function uploadPicked(): Promise<void> {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      await upload(files.map((file) => ({ rel: file.name, file })));
    }

    async function mountFolder(): Promise<void> {
      try {
        await go(await ctx.os.mountNativeFolder());
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') fail('Could not mount the folder', err);
      }
    }

    // ── Menus & keys ───────────────────────────────────────────────────────
    function rowMenu(): MenuItem[] {
      const sel = table.selection;
      const ro = readOnly(cwd);
      const one = sel.length === 1;
      const files = sel.filter((s) => s.kind === 'file');
      return [
        { label: 'Open', hint: 'Enter', action: () => openSelected() },
        { label: 'Open in Editor', action: () => openSelected(true), disabled: !files.length },
        'sep',
        { label: 'Rename', hint: 'F2', action: () => void rename(), disabled: ro || !one },
        { label: 'Duplicate', action: () => void duplicate(), disabled: ro },
        { label: 'Copy', hint: 'Ctrl+C', action: () => toClipboard(false) },
        { label: 'Cut', hint: 'Ctrl+X', action: () => toClipboard(true), disabled: ro },
        { label: 'Paste', hint: 'Ctrl+V', action: () => void paste(), disabled: ro || !clipboard.paths.length },
        { label: 'Download', action: () => void downloadSelected(), disabled: !files.length },
        'sep',
        { label: 'Delete', hint: 'Del', action: () => void remove(), danger: true, disabled: ro },
      ];
    }
    function bgMenu(): MenuItem[] {
      const ro = readOnly(cwd);
      return [
        { label: 'New file', action: () => void newItem('file'), disabled: ro },
        { label: 'New folder', action: () => void newItem('dir'), disabled: ro },
        { label: 'Upload…', action: () => fileInput.click(), disabled: ro },
        { label: 'Paste', hint: 'Ctrl+V', action: () => void paste(), disabled: ro || !clipboard.paths.length },
        'sep',
        { label: 'Refresh', action: () => void refresh() },
      ];
    }

    table.el.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => unknown) => (e.preventDefault(), fn());
      if (e.key === 'Enter') run(() => openSelected());
      else if (e.key === 'Delete') run(() => void remove());
      else if (e.key === 'F2') run(() => void rename());
      else if (e.key === 'Backspace') run(() => void go(dirname(cwd)));
      else if (mod && k === 'c') run(() => toClipboard(false));
      else if (mod && k === 'x') run(() => toClipboard(true));
      else if (mod && k === 'v') run(() => void paste());
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        run(() => {
          const r = (table.cursorRow ?? table.el).getBoundingClientRect();
          openMenu(ctx.root, r.left + 24, r.top + Math.min(r.height, 28), table.selected.size ? rowMenu() : bgMenu(), table.el);
        });
      }
    });
    ctx.root.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowLeft') (e.preventDefault(), void history(-1));
      else if (e.altKey && e.key === 'ArrowRight') (e.preventDefault(), void history(1));
    });

    // Dropping files from the OS uploads them into the current folder.
    const main = table.el.parentElement!;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    main.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = readOnly(cwd) ? 'none' : 'copy';
      main.classList.add('dragging');
    });
    main.addEventListener('dragleave', (e) => {
      if (!main.contains(e.relatedTarget as Node | null)) main.classList.remove('dragging');
    });
    main.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      main.classList.remove('dragging');
      droppedUploads(e.dataTransfer!).then(upload, (err) => fail('Could not read the dropped files', err));
    });

    // ── Live updates ───────────────────────────────────────────────────────
    const liveRefresh = debounce(() => void refresh(), 200);
    ctx.on('fs:change', (c) => {
      if (c.type === 'mount') renderPlaces();
      if (cwd && !busy && (dirname(c.path) === cwd || isInside(c.path, cwd))) liveRefresh();
      updateStorage();
    });

    // ── Start ──────────────────────────────────────────────────────────────
    const start = typeof ctx.args.path === 'string' && ctx.args.path ? resolve(HOME, ctx.args.path) : HOME;
    void go(start, 'none').then(async (ok) => {
      if (!ok && start !== HOME) await go(HOME, 'none');
      updateChrome();
      table.el.focus();
    });
    renderPlaces();
    updateStorage();
    return () => closeMenu();
  },
};

export default app;
