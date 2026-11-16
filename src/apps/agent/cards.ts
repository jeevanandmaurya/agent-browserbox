import type { TodoItem } from '@/agent/tools/types';
import type { PermDecision, PermRequest } from '@/kernel/perms';
import { h } from '@/ui/dom';
import { icon } from './icons';

const CAP_LABEL: Record<string, string> = {
  'fs.write': 'modify files',
  exec: 'run code',
  net: 'use the network',
  clipboard: 'use the clipboard',
  notify: 'send notifications',
  system: 'control the system',
};

/** Inline permission request for this chat's agent. Resolves with the decision; `signal` aborts when answered in another window. */
export function approvalCard(req: PermRequest, signal: AbortSignal | undefined, place: (el: HTMLElement) => void): Promise<PermDecision> {
  return new Promise((resolve) => {
    const settle = (d: PermDecision, how: string) => {
      card.classList.add('settled', d === 'deny' ? 'denied' : 'allowed');
      actions.replaceChildren(h('span', { class: 'ag-card-result' }, icon(d === 'deny' ? 'close' : 'check', 14), how));
      resolve(d);
    };
    const btn = (label: string, d: PermDecision, cls: string, how: string) => h('button', { class: `btn ${cls}`, type: 'button', onclick: () => settle(d, how) }, label);
    const actions = h('div', { class: 'ag-card-actions' }, btn('Deny', 'deny', '', 'Denied'), btn('Always allow', 'always', '', 'Always allowed'), btn('Allow once', 'once', 'primary', 'Allowed once'));
    const card = h(
      'div',
      { class: 'ag-card ag-approval', role: 'group', 'aria-label': 'Permission request' },
      h('div', { class: 'ag-card-head' }, icon('shield', 16), h('span', null, `${req.actor} wants to ${CAP_LABEL[req.cap] ?? req.cap}`)),
      h('div', { class: 'ag-card-sub' }, req.title),
      h('pre', { class: 'ag-card-detail' }, req.detail),
      actions,
    );
    signal?.addEventListener('abort', () => {
      if (card.classList.contains('settled')) return;
      card.classList.add('settled');
      actions.replaceChildren(h('span', { class: 'ag-card-result' }, 'Answered in another window'));
    });
    place(card);
    (actions.querySelector('.primary') as HTMLElement | null)?.focus({ preventScroll: true });
  });
}

/** Inline question from the agent (ask_user). */
export function askCard(question: string, options: string[], place: (el: HTMLElement) => void): Promise<string> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', placeholder: 'Type an answer…', 'aria-label': 'Answer' });
    const answer = (value: string) => {
      if (!value.trim()) return;
      card.classList.add('settled');
      card.replaceChildren(h('div', { class: 'ag-card-head' }, icon('question', 16), h('span', null, question)), h('div', { class: 'ag-card-result' }, icon('check', 14), `You answered: ${value}`));
      resolve(value);
    };
    const card = h(
      'form',
      {
        class: 'ag-card ag-ask',
        onsubmit: (e: Event) => {
          e.preventDefault();
          answer(input.value);
        },
      },
      h('div', { class: 'ag-card-head' }, icon('question', 16), h('span', { class: 'ag-q' }, question)),
      options.length ? h('div', { class: 'ag-opts' }, options.map((o) => h('button', { class: 'btn', type: 'button', onclick: () => answer(o) }, o))) : null,
      h('div', { class: 'ag-ask-row' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Answer')),
    );
    place(card);
    input.focus({ preventScroll: true });
  });
}

export function renderTodos(items: TodoItem[]): HTMLElement | null {
  if (!items.length) return null;
  const done = items.filter((t) => t.status === 'done').length;
  return h(
    'details',
    { class: 'ag-todos', open: done < items.length },
    h('summary', null, h('span', null, `Tasks`), h('span', { class: 'ag-todos-count' }, `${done}/${items.length}`), h('span', { class: 'ag-todos-bar', style: `--p:${Math.round((done / items.length) * 100)}%` })),
    h(
      'ul',
      null,
      items.map((t) => h('li', { class: t.status }, h('span', { class: 'ag-todo-mark', 'aria-label': t.status.replace('_', ' ') }, t.status === 'done' ? '✓' : t.status === 'in_progress' ? '▸' : '○'), h('span', null, t.text))),
    ),
  );
}
