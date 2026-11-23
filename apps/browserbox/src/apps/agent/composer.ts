import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { fmtBytes, h } from '@/ui/dom';
import { openMenu } from '@/ui/menu';
import { icon } from './icons';
import { mentionMenu } from './mention';
import { expandCommand, slashMenu, type SlashCommand } from './slash';

/** How the agent works on the next message: ask before acting, act without asking, or plan first. */
export type AgentMode = 'ask' | 'auto' | 'plan';
export const MODES: Array<{ id: AgentMode; label: string; hint: string; icon: 'shield' | 'spark' | 'fileText' }> = [
  { id: 'ask', label: 'Ask first', hint: 'Approve each change, command and network use', icon: 'shield' },
  // Plan comes before Auto, so Shift+Tab from Ask to Plan never passes through (and turns on) Auto.
  { id: 'plan', label: 'Plan', hint: 'Look around and propose a plan; change nothing', icon: 'fileText' },
  { id: 'auto', label: 'Auto', hint: 'Act without asking (everything stays in the sandbox)', icon: 'spark' },
];

export const UPLOAD_DIR = '/home/agent/uploads';

export interface Composer {
  el: HTMLElement;
  input: HTMLTextAreaElement;
  setBusy(busy: boolean): void;
  focus(): void;
  setText(text: string): void;
  /** The model name on the picker under the text field. */
  setModel(label: string): void;
  /** Holds the context gauge, next to the model picker. */
  meterSlot: HTMLElement;
  /** Messages waiting for the agent to finish, shown above the box. */
  setQueue(items: string[]): void;
  /** Redraws the mode chip after the mode changed elsewhere. */
  syncMode(): void;
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

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null };
const SpeechRecognition = (globalThis as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (globalThis as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

/**
 * The message box: a single rounded bar with + (attach, model, commands),
 * an auto-growing text field, dictation and a round send/stop button.
 */
export function createComposer(
  os: Kernel,
  opts: {
    onSubmit(text: string): boolean;
    onStop(): void;
    openModelMenu(anchor: HTMLElement): void;
    commands: SlashCommand[];
    mode: { get(): AgentMode; set(m: AgentMode): void };
    /** The agent's working folder, for @file mentions. */
    cwd(): string;
    /** Queued messages: remove one, or stop the agent and send them now. */
    queue: { remove(i: number): void; sendNow(): void };
  },
): Composer {
  const attached: Array<{ path: string; size: number }> = [];
  let busy = false;

  const input = h('textarea', { class: 'ag-input', rows: 1, placeholder: 'Message BrowserBox', 'aria-label': 'Message', enterkeyhint: 'send' });
  const chips = h('div', { class: 'cp-chips', hidden: true });
  const file = h('input', { type: 'file', multiple: true, hidden: true, tabindex: -1, 'aria-hidden': 'true' });
  const plusBtn = h('button', { class: 'cp-round cp-plus', type: 'button', title: 'Add', 'aria-label': 'Attach files, model and commands', 'aria-haspopup': 'menu', onclick: () => plusMenu() }, icon('plus', 20));
  const micBtn = h('button', { class: 'cp-round cp-mic', type: 'button', title: 'Dictate', 'aria-label': 'Dictate', 'aria-pressed': 'false', hidden: !SpeechRecognition, onclick: () => toggleDictation() }, icon('mic', 20));
  const modelLabel = h('span', { class: 'cp-model-name' });
  const modelBtn = h('button', { class: 'cp-model', type: 'button', title: 'Model', 'aria-label': 'Change model', 'aria-haspopup': 'menu', onclick: () => opts.openModelMenu(modelBtn) }, modelLabel, icon('chevron', 14));
  const meterSlot = h('span', { class: 'cp-meter' });
  const modeLabel = h('span', { class: 'cp-mode-name' });
  const modeBtn = h('button', { class: 'cp-mode', type: 'button', 'aria-haspopup': 'menu', title: 'Mode (Shift+Tab to switch)', onclick: () => modeMenu() });
  const queueBox = h('div', { class: 'cp-queue', hidden: true, 'aria-live': 'polite' });
  function syncMode(): void {
    const m = MODES.find((x) => x.id === opts.mode.get())!;
    modeBtn.replaceChildren(icon(m.icon, 15), modeLabel);
    modeLabel.textContent = m.label;
    modeBtn.dataset.mode = m.id;
    modeBtn.setAttribute('aria-label', `Mode: ${m.label}. ${m.hint}`);
    input.placeholder = m.id === 'plan' ? 'Describe what to plan' : el.classList.contains('busy') ? 'Queue a message' : input.dataset.base || 'Message BrowserBox';
  }
  function modeMenu(): void {
    openMenu(modeBtn, MODES.map((m) => ({ label: m.label, hint: m.hint, icon: m.icon, checked: opts.mode.get() === m.id, onSelect: () => (opts.mode.set(m.id), syncMode()) })), 'Mode');
  }
  function cycleMode(): void {
    const i = MODES.findIndex((m) => m.id === opts.mode.get());
    opts.mode.set(MODES[(i + 1) % MODES.length]!.id);
    syncMode();
  }
  const sendBtn = h('button', { class: 'cp-send', type: 'submit', title: 'Send (Enter)', 'aria-label': 'Send message', disabled: true }, icon('send', 20));
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
    queueBox,
    chips,
    input,
    h('div', { class: 'cp-bar' }, plusBtn, modeBtn, h('span', { class: 'cp-space' }), meterSlot, modelBtn, micBtn, sendBtn, stopBtn),
    file,
  );
  syncMode();
  os.bus.on('settings:change', ({ key }) => key === 'perms.mode' && syncMode());
  const slash = slashMenu(os, input, opts.commands);
  const mention = mentionMenu(os, input, opts.cwd);
  el.prepend(slash.el, mention.el);
  el.addEventListener('click', (e) => {
    if (e.target === el || (e.target as HTMLElement).classList.contains('cp-bar') || (e.target as HTMLElement).classList.contains('cp-space')) input.focus();
  });

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    // A scrollbar only once the text is taller than the box can grow.
    input.style.overflowY = input.scrollHeight > 200 ? 'auto' : 'hidden';
    const has = !!input.value.trim() || attached.length > 0;
    sendBtn.disabled = !has;
    // While the agent works, a message can still be written and queued.
    sendBtn.hidden = busy && !has;
    sendBtn.title = busy ? 'Queue (Enter): sent when the agent finishes' : 'Send (Enter)';
  };

  function plusMenu(): void {
    openMenu(
      plusBtn,
      [
        { label: 'Attach files', icon: 'clip', onSelect: () => file.click() },
        { label: 'Commands', icon: 'slash', hint: '/compact, /context, your own…', onSelect: () => setText('/') },
      ],
      'Add',
    );
  }

  // --- dictation (Web Speech API, where the browser has it) --------------------
  let rec: Recognition | null = null;
  function toggleDictation(): void {
    if (rec) return rec.stop();
    if (!SpeechRecognition) return;
    rec = new SpeechRecognition();
    rec.lang = navigator.language;
    rec.interimResults = true;
    rec.continuous = true;
    const base = input.value ? `${input.value.replace(/\s+$/, '')} ` : '';
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
      input.value = base + text;
      grow();
    };
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') os.notify({ title: 'Dictation stopped', body: e.error === 'not-allowed' ? 'Microphone permission was denied.' : e.error, level: 'warn' });
    };
    rec.onend = () => {
      rec = null;
      micBtn.setAttribute('aria-pressed', 'false');
      micBtn.classList.remove('on');
      input.focus();
    };
    rec.start();
    micBtn.setAttribute('aria-pressed', 'true');
    micBtn.classList.add('on');
  }

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
    rec?.stop();
    let text = input.value.trim();
    if (!text && !attached.length) return;
    const cmd = !attached.length ? slash.find(text) : null;
    if (cmd?.command.run) {
      cmd.command.run(cmd.args);
      input.value = '';
      grow();
      return;
    }
    if (cmd?.command.template !== undefined) text = expandCommand(cmd.command.template, cmd.args);
    else if (/^\/[\w-]+(\s|$)/.test(text)) {
      os.notify({ title: `Unknown command ${text.split(/\s/)[0]}`, body: 'Type / to see the available commands.', level: 'warn' });
      return;
    }
    if (attached.length) text = `${text || 'Please look at the attached files.'}\n\nAttached files:\n${attached.map((a) => `- ${a.path}`).join('\n')}`;
    if (!opts.onSubmit(text)) return;
    input.value = '';
    attached.length = 0;
    renderChips();
    grow();
  }

  input.addEventListener('keydown', (e) => {
    if (slash.key(e) || mention.key(e)) return e.preventDefault();
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      return cycleMode();
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault();
      return opts.onStop();
    }
    // On touch keyboards Enter inserts a line; the send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', grow);

  function setText(text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  return {
    el,
    input,
    setBusy(b) {
      busy = b;
      stopBtn.hidden = !b;
      el.classList.toggle('busy', b);
      syncMode();
      grow();
    },
    focus: () => input.focus({ preventScroll: true }),
    setText,
    meterSlot,
    syncMode,
    setQueue(items) {
      queueBox.hidden = !items.length;
      queueBox.replaceChildren(
        ...items.map((t, i) =>
          h(
            'div',
            { class: 'cp-queued' },
            h('span', { class: 'cp-queued-label' }, 'Queued'),
            h('span', { class: 'cp-queued-text', title: t }, t),
            i === 0 ? h('button', { class: 'btn small ghost', type: 'button', title: 'Stop the agent and send now', onclick: () => opts.queue.sendNow() }, 'Send now') : null,
            h('button', { class: 'cp-chip-x', type: 'button', 'aria-label': 'Remove from queue', onclick: () => opts.queue.remove(i) }, icon('close', 12)),
          ),
        ),
      );
    },
    setModel(label) {
      modelLabel.textContent = label;
      modelBtn.title = `Model: ${label}`;
    },
  };
}
