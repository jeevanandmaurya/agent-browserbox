import type { ShellHandle } from '@/kernel/api';
import { AnsiView } from './ansi-view';
import { h } from './dom';

export interface TerminalOptions {
  /** Extra class on the container (e.g. for page-specific styling). */
  cls?: string;
  /** Command history for ↑/↓ at the command prompt. */
  history?: { load(): string[]; save(lines: string[]): void };
  /** Tab completion at the command prompt. */
  complete?: (line: string) => Promise<{ start: number; options: string[] }>;
  /** On-screen keys a phone keyboard lacks (shown only on touch screens). */
  keyBar?: boolean;
  maxLines?: number;
}

interface Read {
  prompt: string;
  secret: boolean;
  /** A shell prompt (history, completion, ^C reprints) rather than a program asking for input. */
  command: boolean;
  resolve(value: string | null): void;
}

/**
 * A terminal: coloured output, a prompt line, and line input (optionally
 * hidden). It knows nothing about what runs behind it; `attach` connects it
 * to a kernel shell session. Used by the boot console and the Terminal app.
 */
export class Terminal {
  readonly el: HTMLElement;
  readonly view: AnsiView;
  readonly #scroller: HTMLElement;
  readonly #promptEl = h('span', { class: 'term-prompt' });
  readonly #input = h('input', { class: 'term-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Command line' });
  readonly #line = h('div', { class: 'term-line busy' }, this.#promptEl, this.#input);
  #read: Read | null = null;
  #interrupt: (() => void) | null = null;
  #history: string[];
  #histIndex = -1;
  #draft = '';

  constructor(private opts: TerminalOptions = {}) {
    this.#history = opts.history?.load() ?? [];
    this.view = new AnsiView('term-out', { maxLines: opts.maxLines ?? 3000, onFlush: () => (this.#scroller.scrollTop = this.#scroller.scrollHeight) });
    this.#scroller = h('div', { class: 'term-scroll', onclick: () => !getSelection()?.toString() && this.focus() }, this.view.el, this.#line);
    this.el = h('div', { class: `term ${opts.cls ?? ''}` }, this.#scroller, opts.keyBar ? this.#keyBar() : null);
    this.#input.addEventListener('keydown', (e) => this.#key(e));
  }

  write(text: string): void {
    this.view.write(text);
  }

  clear(): void {
    this.view.clear();
  }

  focus(): void {
    this.#input.focus({ preventScroll: true });
  }

  /** Shows `prompt` and resolves with the line typed, or null on ^D/^C. */
  readLine(prompt: string, opts: { secret?: boolean; command?: boolean } = {}): Promise<string | null> {
    this.#read?.resolve(null);
    return new Promise((resolve) => {
      this.view.flush();
      // The prompt may contain colour codes: render it with the same logic as output.
      const p = new AnsiView();
      p.write(prompt);
      p.flush();
      this.#promptEl.replaceChildren(...(p.el.firstElementChild?.childNodes ?? []));
      this.#input.type = opts.secret ? 'password' : 'text';
      this.#input.value = '';
      this.#line.classList.remove('busy');
      this.#read = {
        prompt,
        secret: opts.secret ?? false,
        command: opts.command ?? false,
        resolve: (v) => {
          this.#read = null;
          this.#line.classList.add('busy');
          this.#input.type = 'text';
          resolve(v);
        },
      };
      this.focus();
    });
  }

  /** Lets programs in `shell` read input and clear the screen here. */
  attach(shell: ShellHandle): void {
    shell.onReadLine((prompt, secret) => this.readLine(prompt, { secret }));
    shell.onClear(() => this.clear());
  }

  /** Runs a command line in `shell`, streaming its output here. ^C interrupts it. */
  async run(shell: ShellHandle, line: string): Promise<number> {
    const ctl = new AbortController();
    this.#interrupt = () => ctl.abort();
    try {
      return await shell.run(line, { out: (t) => this.write(t), err: (t) => this.write(`\x1b[31m${t}\x1b[0m`), signal: ctl.signal });
    } catch (err) {
      this.write(`\x1b[31m${(err as Error).message}\x1b[0m\n`);
      return 1;
    } finally {
      this.#interrupt = null;
      this.view.flush();
      if (this.view.currentLine) this.write('\n');
    }
  }

  #echo(value: string, suffix = ''): void {
    const r = this.#read!;
    this.write(`${r.prompt}${r.secret && value ? '••••••••' : value}${suffix}\n`);
  }

  #key(e: KeyboardEvent): void {
    const r = this.#read;
    const input = this.#input;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!r) return;
      const value = input.value;
      input.value = '';
      this.#echo(value);
      if (r.command && value.trim() && this.#history.at(-1) !== value) {
        this.#history.push(value);
        this.opts.history?.save(this.#history.slice(-200));
      }
      this.#histIndex = -1;
      r.resolve(value);
    } else if (e.key === 'c' && e.ctrlKey && input.selectionStart === input.selectionEnd) {
      // With text selected, Ctrl+C copies; otherwise it interrupts.
      e.preventDefault();
      if (this.#interrupt) {
        this.#interrupt();
        if (r) r.resolve(null);
      } else if (r) {
        this.#echo(input.value, '^C');
        r.resolve('');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      this.clear();
    } else if (e.key === 'd' && e.ctrlKey && !input.value && r && !r.command) {
      e.preventDefault();
      r.resolve(null);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && r?.command && this.opts.history) {
      e.preventDefault();
      if (this.#histIndex < 0) this.#draft = input.value;
      const n = this.#history.length;
      this.#histIndex = e.key === 'ArrowUp' ? (this.#histIndex < 0 ? n - 1 : Math.max(0, this.#histIndex - 1)) : this.#histIndex < 0 || this.#histIndex >= n - 1 ? -1 : this.#histIndex + 1;
      input.value = this.#histIndex < 0 ? this.#draft : (this.#history[this.#histIndex] ?? '');
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    } else if (e.key === 'Tab' && r?.command && this.opts.complete) {
      e.preventDefault();
      const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
      void this.opts.complete(upto).then(({ start, options }) => {
        if (!options.length) return;
        if (options.length === 1) return void (input.value = upto.slice(0, start) + options[0] + input.value.slice(upto.length));
        // Complete the common prefix; when there is none to add, list the candidates.
        let prefix = options[0]!;
        for (const o of options) while (!o.startsWith(prefix)) prefix = prefix.slice(0, -1);
        if (prefix.length > upto.length - start) input.value = upto.slice(0, start) + prefix + input.value.slice(upto.length);
        else this.write(`${r.prompt}${input.value}\n${options.map((o) => o.trim()).join('  ')}\n`);
      });
    }
  }

  #keyBar(): HTMLElement {
    const input = this.#input;
    const key = (label: string, title: string, act: () => void) => h('button', { class: 'term-key', type: 'button', title, 'aria-label': title, onclick: act }, label);
    const press = (k: string, ctrlKey = false) => () => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey, bubbles: true, cancelable: true }));
    const type = (text: string) => () => input.setRangeText(text, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
    const bar = h(
      'div',
      { class: 'term-keys', role: 'toolbar', 'aria-label': 'Terminal keys' },
      key('Tab', 'Complete', press('Tab')),
      key('↑', 'Previous command', press('ArrowUp')),
      key('↓', 'Next command', press('ArrowDown')),
      key('^C', 'Interrupt', press('c', true)),
      key('^L', 'Clear screen', press('l', true)),
      ...['|', '/', '-', '~', '"', '&&', '>'].map((c) => key(c, `Insert ${c}`, type(c))),
    );
    // Tapping a key must not take focus (and the on-screen keyboard) away from the input.
    bar.addEventListener('pointerdown', (e) => e.preventDefault());
    return bar;
  }
}
