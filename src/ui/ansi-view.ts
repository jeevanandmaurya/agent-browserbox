import { h } from './dom';

const SGR: Record<string, string> = { '1': 'a-bold', '2': 'a-dim', '31': 'a-red', '32': 'a-green', '33': 'a-yellow', '34': 'a-blue', '35': 'a-magenta', '36': 'a-cyan' };
const TOKEN = /(\x1b\[[0-9;]*m|\r\n|\r|\n)/;

/**
 * Terminal output: ANSI colours, newlines and carriage returns (so a progress
 * bar can redraw its line). Output is batched to one DOM update per frame.
 * Each line is a span followed by a "\n" text node, so textContent reads like
 * the terminal's text.
 */
export class AnsiView {
  readonly el: HTMLElement;
  #line: HTMLElement;
  #style: string[] = [];
  #pending = '';
  #scheduled = false;

  constructor(
    cls = '',
    private opts: { maxLines?: number; onFlush?: () => void } = {},
  ) {
    this.el = h('div', { class: `ansi ${cls}`, 'aria-live': 'polite' });
    this.#line = this.#newLine();
  }

  #newLine(): HTMLElement {
    const line = h('span', { class: 'ansi-line' });
    this.el.append(line);
    return line;
  }

  write(text: string): void {
    this.#pending += text;
    if (this.#scheduled) return;
    this.#scheduled = true;
    requestAnimationFrame(() => this.flush());
  }

  /** Applies pending output now. */
  flush(): void {
    this.#scheduled = false;
    const text = this.#pending;
    this.#pending = '';
    if (!text) return;
    for (const part of text.split(TOKEN)) {
      if (!part) continue;
      if (part === '\n' || part === '\r\n') {
        this.el.append('\n');
        this.#line = this.#newLine();
      } else if (part === '\r') this.#line.replaceChildren();
      else if (part.startsWith('\x1b[')) {
        for (const code of (part.slice(2, -1) || '0').split(';')) {
          if (code === '0' || code === '') this.#style = [];
          else if (SGR[code]) this.#style.push(SGR[code]);
        }
      } else this.#line.append(this.#style.length ? h('span', { class: this.#style.join(' ') }, part) : part);
    }
    const max = (this.opts.maxLines ?? 5000) * 2;
    while (this.el.childNodes.length > max) this.el.firstChild!.remove();
    this.opts.onFlush?.();
  }

  clear(): void {
    this.#pending = '';
    this.el.replaceChildren();
    this.#line = this.#newLine();
  }

  /** Text of the line being written (e.g. a prompt). */
  get currentLine(): string {
    return this.#line.textContent ?? '';
  }
}

export { plainText } from '@/shell/ansi';
