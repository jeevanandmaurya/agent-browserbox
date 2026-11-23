import type { FileDiff } from '@jeevanand/agent-browserbox/ui';
import { h } from '@/ui/dom';

/** "+12 −3", for headers and tool cards. */
export function diffStat(d: Pick<FileDiff, 'added' | 'removed' | 'before' | 'after'>): HTMLElement {
  return h(
    'span',
    { class: 'df-stat' },
    d.before === null ? h('span', { class: 'df-tag' }, 'new') : d.after === null ? h('span', { class: 'df-tag del' }, 'deleted') : null,
    h('span', { class: 'df-add' }, `+${d.added}`),
    h('span', { class: 'df-del' }, `−${d.removed}`),
  );
}

/** A file's changes as coloured lines with old and new line numbers. */
export function diffView(d: FileDiff): HTMLElement {
  const rows: HTMLElement[] = [];
  d.hunks.forEach((hunk, i) => {
    if (i > 0 || hunk.oldStart > 1) rows.push(h('div', { class: 'df-gap', 'aria-hidden': 'true' }, '⋯'));
    for (const l of hunk.lines) {
      rows.push(
        h(
          'div',
          { class: `df-line ${l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}` },
          h('span', { class: 'df-num' }, l.old ? String(l.old) : ''),
          h('span', { class: 'df-num' }, l.new ? String(l.new) : ''),
          h('span', { class: 'df-sign', 'aria-hidden': 'true' }, l.kind === ' ' ? '' : l.kind === '-' ? '−' : '+'),
          h('span', { class: 'df-text' }, l.text || ' '),
        ),
      );
    }
  });
  return h(
    'div',
    { class: 'df', role: 'table', 'aria-label': `Changes to ${d.path}` },
    rows,
    d.note ? h('p', { class: 'df-note' }, d.note) : null,
    !d.hunks.length && !d.note ? h('p', { class: 'df-note' }, d.before === null ? 'Empty file created.' : 'No changes.') : null,
  );
}
