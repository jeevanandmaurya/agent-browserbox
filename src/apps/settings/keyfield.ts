import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { errText, nextId } from './nav';

interface KeyFieldOptions {
  secret: string;
  label: string;
  placeholder: string;
  note: string;
  onSaved: () => void;
}

/**
 * API key entry backed by the encrypted secret store. The stored key is never
 * read back into the page; we only show whether one exists.
 */
export function keyField(ctx: AppContext, o: KeyFieldOptions): HTMLElement {
  const { os } = ctx;
  const id = nextId('key');
  const status = h('span', { class: 'badge', 'aria-live': 'polite' }, 'checking…');
  const input = h('input', {
    class: 'input mono',
    id,
    type: 'password',
    autocomplete: 'off',
    placeholder: o.placeholder,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void save();
      }
    },
    oninput: () => (saveBtn.disabled = !input.value.trim()),
  });
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => void save() }, 'Save key');
  const removeBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => void remove() }, 'Remove');
  const error = h('p', { class: 'st-error', hidden: true, role: 'alert' });

  async function refresh(): Promise<void> {
    const has = await os.secrets.has(o.secret).catch(() => false);
    status.textContent = has ? 'saved ✓' : 'not set';
    status.className = `badge ${has ? 'ok' : ''}`;
    removeBtn.hidden = !has;
    input.placeholder = has ? 'Enter a new key to replace the saved one' : o.placeholder;
  }

  async function save(): Promise<void> {
    const value = input.value.trim();
    if (!value) return;
    saveBtn.disabled = true;
    error.hidden = true;
    try {
      await os.secrets.set(o.secret, value);
      input.value = '';
      o.onSaved();
    } catch (err) {
      error.textContent = `Could not save the key: ${errText(err)}`;
      error.hidden = false;
    }
    await refresh();
  }

  async function remove(): Promise<void> {
    if (!(await confirmDialog('Remove API key?', 'The saved key will be deleted from this browser.', 'Remove', true))) return;
    await os.secrets.delete(o.secret);
    o.onSaved();
    await refresh();
  }

  void refresh();
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'row st-key-label' }, h('label', { for: id }, o.label), status),
    h('div', { class: 'row st-key-row' }, input, saveBtn, removeBtn),
    error,
    h('p', { class: 'muted st-note' }, o.note),
  );
}
