import type { Kernel } from '@/kernel/api';
import { fmtBytes, h } from '@/ui/dom';
import { icon } from './icons';
import { modelPicker } from './model-picker';

export const UPLOAD_DIR = '/home/agent/uploads';

export interface Composer {
  el: HTMLElement;
  input: HTMLTextAreaElement;
  setBusy(busy: boolean): void;
  focus(): void;
  refreshModel(): void;
  setText(text: string): void;
}

/** Picks a name in the uploads folder that does not overwrite an earlier upload. */
async function freePath(os: Kernel, name: string): Promise<string> {
  const safe = name.replace(/[/\\\0]/g, '_') || 'file';
  const dot = safe.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
  for (let i = 0; ; i++) {
    const p = `${UPLOAD_DIR}/${i ? `${stem}-${i}${ext}` : safe}`;
    if (!(await os.fs.exists(p))) return p;
  }
}

/**
 * The message box: auto-growing textarea, file attachments (copied into the
 * agent's uploads folder and referenced by path), model picker, send/stop.
 */
export function createComposer(os: Kernel, opts: { onSubmit(text: string): boolean; onStop(): void; openModelSettings(): void }): Composer {
  const attached: Array<{ path: string; size: number }> = [];
  let busy = false;

  const input = h('textarea', { class: 'ag-input', rows: 1, placeholder: 'Message BrowserBox…', 'aria-label': 'Message', enterkeyhint: 'send' });
  const chips = h('div', { class: 'cp-chips', hidden: true });
  const file = h('input', { type: 'file', multiple: true, hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const attachBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => file.click() }, icon('clip', 18));
  const picker = modelPicker(os, opts.openModelSettings);
  const sendBtn = h('button', { class: 'cp-send', type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send message', disabled: true }, icon('send', 18));
  const stopBtn = h('button', { class: 'cp-send stop', type: 'button', title: 'Stop', 'aria-label': 'Stop the agent', hidden: true, onclick: () => opts.onStop() }, icon('stop', 16));

  const el = h(
    'form',
    {
      class: 'composer',
      onsubmit: (e: Event) => {
        e.preventDefault();
        submit();
      },
    },
    chips,
    input,
    h('div', { class: 'cp-bar' }, attachBtn, picker.el, h('span', { class: 'spacer' }), sendBtn, stopBtn),
    file,
  );
  el.addEventListener('click', (e) => {
    if (e.target === el) input.focus();
  });

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    sendBtn.disabled = busy || (!input.value.trim() && !attached.length);
  };

  function renderChips(): void {
    chips.hidden = !attached.length;
    chips.replaceChildren(
      ...attached.map((a, i) =>
        h(
          'span',
          { class: 'cp-chip', title: a.path },
          h('span', { class: 'cp-chip-name' }, a.path.slice(UPLOAD_DIR.length + 1)),
          h('span', { class: 'cp-chip-size' }, fmtBytes(a.size)),
          h(
            'button',
            {
              type: 'button',
              class: 'cp-chip-x',
              'aria-label': `Remove ${a.path}`,
              onclick: () => {
                attached.splice(i, 1);
                renderChips();
                grow();
              },
            },
            icon('close', 12),
          ),
        ),
      ),
    );
  }

  file.addEventListener('change', async () => {
    const files = [...(file.files ?? [])];
    file.value = '';
    for (const f of files) {
      try {
        const path = await freePath(os, f.name);
        await os.fs.writeFile(path, new Uint8Array(await f.arrayBuffer()));
        attached.push({ path, size: f.size });
      } catch (err) {
        os.notify({ title: `Could not attach ${f.name}`, body: (err as Error).message, level: 'error' });
      }
    }
    renderChips();
    grow();
    input.focus();
  });

  function submit(): void {
    if (busy) return;
    let text = input.value.trim();
    if (!text && !attached.length) return;
    if (attached.length) text = `${text || 'Please look at the attached files.'}\n\nAttached files:\n${attached.map((a) => `- ${a.path}`).join('\n')}`;
    if (!opts.onSubmit(text)) return;
    input.value = '';
    attached.length = 0;
    renderChips();
    grow();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', grow);

  return {
    el,
    input,
    setBusy(b) {
      busy = b;
      sendBtn.hidden = b;
      stopBtn.hidden = !b;
      el.classList.toggle('busy', b);
      grow();
    },
    focus: () => input.focus({ preventScroll: true }),
    refreshModel: picker.refresh,
    setText(text) {
      input.value = text;
      grow();
      input.focus();
    },
  };
}
