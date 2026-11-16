import type { PermDecision, PermRequest } from '@/kernel/perms';
import { h } from './dom';

function modal(content: HTMLElement, onDismiss: () => void): () => void {
  const overlay = h('div', { class: 'modal-overlay' }, content);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDismiss();
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) onDismiss();
  });
  addEventListener('keydown', key, true);
  document.body.append(overlay);
  (content.querySelector('[autofocus]') as HTMLElement | null)?.focus();
  return () => {
    removeEventListener('keydown', key, true);
    overlay.remove();
  };
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      close();
      resolve(v);
    };
    const close = modal(
      h(
        'div',
        { class: 'modal', role: 'alertdialog', 'aria-label': title },
        h('h3', null, title),
        h('p', null, message),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true, onclick: () => done(true) }, okLabel),
        ),
      ),
      () => done(false),
    );
  });
}

export function promptDialog(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value: initial, autofocus: true, 'aria-label': label });
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    const form = h(
      'form',
      {
        class: 'modal',
        role: 'dialog',
        'aria-label': title,
        onsubmit: (e: Event) => {
          e.preventDefault();
          done(input.value);
        },
      },
      h('h3', null, title),
      h('label', { class: 'field' }, h('span', null, label), input),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'OK')),
    );
    const close = modal(form, () => done(null));
    input.select();
  });
}

const CAP_LABEL: Record<string, string> = {
  'fs.write': 'modify files',
  exec: 'run code',
  net: 'use the network',
  clipboard: 'use the clipboard',
  notify: 'send notifications',
  system: 'control the system',
};

/** The default permission prompt, shown when a sandboxed actor needs a capability. */
export function permissionDialog(req: PermRequest, signal?: AbortSignal): Promise<PermDecision> {
  return new Promise((resolve) => {
    // Answered in another window: just dismiss this copy.
    signal?.addEventListener('abort', () => close());
    const done = (d: PermDecision) => {
      close();
      resolve(d);
    };
    const close = modal(
      h(
        'div',
        { class: 'modal perm', role: 'alertdialog', 'aria-label': 'Permission request' },
        h('h3', null, `${req.actor} wants to ${CAP_LABEL[req.cap] ?? req.cap}`),
        h('p', null, req.title),
        h('pre', { class: 'perm-detail' }, req.detail),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => done('deny') }, 'Deny'),
          h('button', { class: 'btn', onclick: () => done('always') }, `Always allow`),
          h('button', { class: 'btn primary', autofocus: true, onclick: () => done('once') }, 'Allow once'),
        ),
      ),
      () => done('deny'),
    );
  });
}
