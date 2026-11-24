import { diffFiles } from '@jeevanand/agent-browserbox/ui';
import type { AgentHandle, Isolation } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { diffStat, diffView } from './diffview';
import { icon } from './icons';

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
const KIND = { added: 'new', modified: 'changed', deleted: 'deleted' } as const;

/**
 * An isolated chat's copy, reviewed: each file it added, changed or deleted
 * compared with the project folder, and applying the changes to the folder
 * (one file, or all) or throwing them away. Loaded when first opened.
 */
export function openIsolation(os: Kernel, agent: AgentHandle, opts: { openFile(path: string): void; onChanged(): void }): void {
  const list = h('div', { class: 'ch-list' }, h('p', { class: 'muted' }, 'Loading…'));
  const note = h('p', { class: 'muted ch-note' });
  const discardAll = h('button', { class: 'btn ghost', type: 'button', disabled: true }, 'Discard all');
  const applyAll = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Apply all');
  const stop = h('button', { class: 'btn ghost', type: 'button', hidden: true }, 'Work in the folder itself');
  const close = () => {
    overlay.remove();
    removeEventListener('keydown', onKey, true);
  };
  const dialog = h(
    'div',
    { class: 'sm-dialog ch-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'This chat’s copy' },
    h('header', { class: 'sm-head' }, h('h2', null, 'This chat’s copy'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18))),
    h('div', { class: 'ch-body' }, note, list),
    h('footer', { class: 'ch-foot' }, stop, discardAll, applyAll),
  );
  const overlay = h('div', { class: 'sm-overlay', onpointerdown: (e: Event) => e.target === overlay && close() }, dialog);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
  addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  const act = async (fn: () => Promise<unknown>, failed: string) => {
    try {
      await fn();
    } catch (err) {
      os.notify({ title: failed, body: (err as Error).message, level: 'error' });
    }
    opts.onChanged();
    void render();
  };

  async function render(): Promise<void> {
    const iso: Isolation | null = await agent.isolation().catch(() => null);
    if (!iso) return void (close(), opts.onChanged());
    const { changes } = iso;
    note.textContent = `The agent works in ${iso.folder}, a copy of ${iso.lower}. The folder changes only when you apply.`;
    applyAll.disabled = discardAll.disabled = !changes.length;
    stop.hidden = !!changes.length;
    applyAll.onclick = () => void act(async () => {
      const done = await agent.applyWork();
      os.notify({ title: `Applied ${files(done.length)} to ${iso.lower}`, level: 'ok' });
    }, 'Could not apply the changes');
    discardAll.onclick = async () => {
      if (!(await confirmDialog('Discard all changes?', `${files(changes.length)} in this chat’s copy go back to how they are in ${iso.lower}. The folder is not touched.`, 'Discard all', true))) return;
      void act(() => agent.discardWork(), 'Could not discard the changes');
    };
    stop.onclick = () => void act(async () => (await agent.isolate(false), close()), 'Could not stop working on a copy');
    if (!changes.length) {
      list.replaceChildren(h('p', { class: 'ch-empty' }, 'No changes yet: the copy is the same as the folder.'));
      return;
    }
    const rows = await Promise.all(
      changes.map(async (c) => {
        const [before, after] = await Promise.all([
          c.kind === 'added' ? null : os.fs.readText(iso.lower + c.path).catch(() => null),
          c.kind === 'deleted' ? null : os.fs.readText(iso.folder + c.path).catch(() => null),
        ]);
        const diff = diffFiles(c.path, before, after);
        return h(
          'details',
          { class: 'ch-file' },
          h(
            'summary',
            null,
            icon(c.kind === 'deleted' ? 'trash' : c.kind === 'added' ? 'filePlus' : 'file', 15),
            h('span', { class: 'ch-path', title: c.path }, c.path.slice(1)),
            h('span', { class: 'muted' }, KIND[c.kind]),
            diffStat(diff),
            h(
              'span',
              { class: 'ch-actions' },
              c.kind === 'deleted' ? null : h('button', { class: 'btn small ghost', type: 'button', onclick: (e: Event) => (e.preventDefault(), opts.openFile(iso.folder + c.path), close()) }, 'Open'),
              h('button', { class: 'btn small ghost', type: 'button', title: 'Put the copy’s file back as it is in the folder', onclick: (e: Event) => (e.preventDefault(), void act(() => agent.discardWork([c.path]), 'Could not discard')) }, 'Discard'),
              h('button', { class: 'btn small ghost', type: 'button', title: 'Copy this change into the folder', onclick: (e: Event) => (e.preventDefault(), void act(() => agent.applyWork([c.path]), 'Could not apply')) }, 'Apply'),
            ),
          ),
          diffView(diff),
        );
      }),
    );
    list.replaceChildren(...rows);
  }
  void render();
}
