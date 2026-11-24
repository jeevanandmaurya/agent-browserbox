import { previewStore } from '@/app/preview-storage';
import { canShareFiles, shareableFile, shareFiles } from '@/app/share';
import './style.css';
import { artifactsDir, deleteArtifact, listArtifacts, readArtifact, updateArtifact, versionPath, type Artifact } from '@jeevanand/agent-browserbox/ui';
import { currentProject } from '@/app/project';
import type { AppModule } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { openMenu } from '@/ui/menu';
import { fmtTime, h } from '@/ui/dom';
import { icon } from '@/ui/icons';
import { renderArtifact } from './render';

const KIND_LABEL: Record<string, string> = { html: 'Page', markdown: 'Document', svg: 'Image', mermaid: 'Diagram', code: 'Code', csv: 'Table' };

/**
 * Artifacts: what the agent made for you to keep, per project. The list, and
 * one artifact with its versions. Opened from an artifact card in the chat,
 * from the side panel, or on the desktop.
 */
const app: AppModule = {
  async mount(ctx) {
    const { os, root, win } = ctx;
    const folder = typeof ctx.args.folder === 'string' ? ctx.args.folder : currentProject(os).folder;
    const body = h('div', { class: 'af-body' });
    const bar = h('div', { class: 'af-bar' });
    root.append(h('div', { class: 'af' }, bar, body));
    let showing: { id: string; version?: number } | null = typeof ctx.args.id === 'string' ? { id: ctx.args.id, ...(typeof ctx.args.version === 'number' ? { version: ctx.args.version } : {}) } : null;
    let renderSeq = 0;

    async function showList(): Promise<void> {
      showing = null;
      win.setTitle('Artifacts');
      win.setArgs?.({ folder });
      const search = h('input', { class: 'input af-search', type: 'search', placeholder: 'Search artifacts', 'aria-label': 'Search artifacts' });
      bar.replaceChildren(h('strong', null, `Artifacts · ${currentProject(os).name}`), search);
      const all = await listArtifacts(os, folder);
      const list = h('div', { class: 'af-list', role: 'list' });
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        const shown = all.filter((a) => !q || a.title.toLowerCase().includes(q));
        list.replaceChildren(
          ...(shown.length
            ? shown.map((a) =>
                h(
                  'button',
                  { class: 'af-item', type: 'button', role: 'listitem', onclick: () => void showOne(a.id) },
                  icon(a.kind === 'html' ? 'globe' : a.kind === 'csv' ? 'grid' : a.kind === 'code' ? 'code' : a.kind === 'svg' || a.kind === 'mermaid' ? 'image' : 'fileText', 18),
                  h('span', { class: 'af-item-title' }, a.title),
                  h('span', { class: 'muted' }, `${KIND_LABEL[a.kind] ?? a.kind} · v${a.versions.at(-1)!.n} · ${fmtTime(a.versions.at(-1)!.at)}`),
                ),
              )
            : [h('p', { class: 'muted af-empty' }, all.length ? 'No artifacts match.' : 'Nothing here yet. Ask the agent for a document, a page, a diagram or a table, and it appears here.')]),
        );
      };
      search.addEventListener('input', fill);
      fill();
      body.replaceChildren(list);
    }

    async function showOne(id: string, version?: number): Promise<void> {
      const seq = ++renderSeq;
      let r: Awaited<ReturnType<typeof readArtifact>>;
      try {
        r = await readArtifact(os, folder, id, version);
      } catch (err) {
        body.replaceChildren(h('p', { class: 'af-note' }, (err as Error).message));
        return;
      }
      if (seq !== renderSeq) return;
      showing = { id, ...(version !== undefined ? { version } : {}) };
      const a: Artifact = r.artifact;
      win.setTitle(a.title);
      win.setArgs?.({ folder, id, ...(version !== undefined ? { version } : {}) });
      // One slim row: back, title, version, then the common actions as icons and the rest in a menu.
      const versions = h('select', { class: 'select af-version', 'aria-label': 'Version', title: 'Version', onchange: () => void showOne(id, Number(versions.value)) }, [...a.versions].reverse().map((v) => h('option', { value: String(v.n), title: `${v.note ?? ''} ${fmtTime(v.at)}`.trim() }, `v${v.n}${v.note ? ` · ${v.note}` : ''}`)));
      versions.value = String(r.version);
      versions.hidden = a.versions.length < 2;
      const file = versionPath(folder, a, r.version);
      const iconBtn = (label: string, ic: Parameters<typeof icon>[0], onclick: (e: Event) => void) => h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick }, icon(ic, 16));
      const download = () => {
        const url = URL.createObjectURL(new Blob([r.content], { type: 'text/plain' }));
        Object.assign(document.createElement('a'), { href: url, download: file.split('/').pop()!.replace(/^v/, `${id}-v`) }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const share = () =>
        void shareFiles([shareableFile(file.split('/').pop()!.replace(/^v\d+/, a.title.replace(/[/\\:*?"<>|]+/g, ' ').trim() || id), r.content)], a.title).catch((err: Error) => os.notify({ title: 'Could not share', body: err.message, level: 'error' }));
      const remove = async () => {
        if (!(await confirmDialog(`Delete “${a.title}”?`, 'Every version is deleted.', 'Delete', true))) return;
        await deleteArtifact(os, folder, id);
        await showList();
      };
      const more = iconBtn('More', 'more', (e) =>
        openMenu(e.currentTarget as HTMLElement, [
          { label: 'Copy', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(r.content).then(() => os.notify({ title: 'Copied', level: 'ok' })) },
          { label: 'Download', icon: 'download', onSelect: download },
          ...(canShareFiles() ? [{ label: 'Share…', icon: 'external' as const, onSelect: share }] : []),
          { separator: true },
          { label: 'Delete', icon: 'trash', onSelect: () => void remove() },
        ], a.title),
      );
      bar.replaceChildren(
        iconBtn('All artifacts', 'arrowLeft', () => void showList()),
        h('strong', { class: 'af-title', title: `${a.title} · ${KIND_LABEL[a.kind] ?? a.kind} · v${r.version}` }, a.title),
        versions,
        h(
          'span',
          { class: 'af-actions' },
          // Editing makes a new version, so the agent's versions stay as they were.
          iconBtn('Edit', 'edit', async () => {
            const next = await updateArtifact(os, folder, id, { content: r.content, note: 'edited by you' });
            ctx.launch('editor', { path: versionPath(folder, next) });
          }),
          iconBtn('Open in new tab', 'external', () =>
            void import('@/app/app-tab').then(({ openAppTab }) => openAppTab('artifacts', { folder, id, ...(version !== undefined ? { version } : {}) }) || os.notify({ title: 'Allow pop-ups to open it in a tab', level: 'warn' })),
          ),
          more,
        ),
      );
      body.replaceChildren(h('p', { class: 'muted af-note' }, 'Loading…'));
      const view = await renderArtifact(a, r.content, (key) => previewStore(os, key));
      if (seq === renderSeq) body.replaceChildren(view);
    }

    // A new version from the agent (or an edit) shows at once when the latest is on screen.
    ctx.on('fs:change', ({ path }) => {
      if (!path.startsWith(`${artifactsDir(folder)}/`)) return;
      if (showing && !showing.version && path.startsWith(`${artifactsDir(folder)}/${showing.id}/`)) void showOne(showing.id);
      else if (!showing) void showList();
    });

    if (showing) await showOne(showing.id, showing.version);
    else await showList();
  },
};
export default app;
