import { diffFiles, type FileDiff } from '@/agent/diff';
import type { AgentHandle, Kernel, TurnChanges } from '@/agent/api';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { diffStat, diffView } from './diffview';
import { icon } from './icons';

export interface FileChange {
  path: string;
  /** Content before the agent first changed it in this chat (null: did not exist). */
  before: string | null;
  /** Restorable: text we kept. Binary or very large files were not kept. */
  restorable: boolean;
  diff: FileDiff | null;
}

/** Every file the agent's file tools changed in this chat, compared with how it was before the first change. */
export async function collectChanges(os: Kernel, turns: TurnChanges[]): Promise<FileChange[]> {
  const first = new Map<string, TurnChanges['files'][number]>();
  for (const t of turns) for (const f of t.files) if (!first.has(f.path)) first.set(f.path, f);
  const out: FileChange[] = [];
  for (const f of first.values()) {
    const now = await os.fs.readText(f.path).catch(() => null);
    const restorable = !f.binary && !f.skipped;
    const before = f.existed ? f.before : null;
    const diff = restorable ? diffFiles(f.path, before, now) : null;
    if (diff && !diff.added && !diff.removed && (before === null) === (now === null)) continue; // back as it was
    out.push({ path: f.path, before, restorable, diff });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function undoFile(os: Kernel, c: FileChange): Promise<void> {
  if (c.before === null) await os.fs.rm(c.path, { recursive: true }).catch(() => undefined);
  else await os.fs.writeFile(c.path, c.before);
}

/**
 * The Changes panel: what the agent changed in this chat, file by file, with
 * diffs, and undo for one file or all of them. The chat itself is untouched.
 */
export function openChanges(os: Kernel, agent: AgentHandle, opts: { openFile(path: string): void; onChanged(): void }): void {
  const list = h('div', { class: 'ch-list' }, h('p', { class: 'muted' }, 'Loading…'));
  const undoAll = h('button', { class: 'btn', type: 'button', disabled: true }, 'Undo all');
  const close = () => {
    overlay.remove();
    removeEventListener('keydown', onKey, true);
  };
  const dialog = h(
    'div',
    { class: 'sm-dialog ch-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Changes in this chat' },
    h('header', { class: 'sm-head' }, h('h2', null, 'Changes in this chat'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close', 18))),
    h('div', { class: 'ch-body' }, list, h('p', { class: 'muted ch-note' }, 'Changes made with the agent’s file tools are tracked. Changes made by shell commands or scripts are not.')),
    h('footer', { class: 'ch-foot' }, undoAll),
  );
  const overlay = h('div', { class: 'sm-overlay', onpointerdown: (e: Event) => e.target === overlay && close() }, dialog);
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), close());
  addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  async function render(): Promise<void> {
    const changes = await collectChanges(os, await agent.changes());
    undoAll.disabled = !changes.some((c) => c.restorable);
    undoAll.onclick = async () => {
      if (!(await confirmDialog('Undo all changes?', `${changes.length} file${changes.length === 1 ? '' : 's'} go back to how they were before this chat changed them. The chat stays as it is.`, 'Undo all', true))) return;
      for (const c of changes) if (c.restorable) await undoFile(os, c);
      opts.onChanged();
      void render();
    };
    if (!changes.length) {
      list.replaceChildren(h('p', { class: 'ch-empty' }, 'No file changes in this chat.'));
      return;
    }
    list.replaceChildren(
      ...changes.map((c) =>
        h(
          'details',
          { class: 'ch-file' },
          h(
            'summary',
            null,
            icon('file', 15),
            h('span', { class: 'ch-path', title: c.path }, c.path),
            c.diff ? diffStat(c.diff) : h('span', { class: 'muted' }, 'binary or large'),
            h('span', { class: 'ch-actions' },
              h('button', { class: 'btn small ghost', type: 'button', onclick: (e: Event) => (e.preventDefault(), opts.openFile(c.path), close()) }, 'Open'),
              h('button', { class: 'btn small ghost', type: 'button', disabled: !c.restorable, title: c.restorable ? 'Put this file back as it was' : 'Not kept: binary or too large', onclick: async (e: Event) => {
                e.preventDefault();
                await undoFile(os, c);
                opts.onChanged();
                void render();
              } }, 'Undo'),
            ),
          ),
          c.diff ? diffView(c.diff) : h('p', { class: 'muted' }, 'This file was not kept (binary or too large), so it cannot be shown or undone.'),
        ),
      ),
    );
  }
  void render();
}
