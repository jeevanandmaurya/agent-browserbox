/** Collapsible output panel that runs the buffer in the JS or Python sandbox. */
import type { AppContext } from '@/ui/apps';
import { fmtDuration, h } from '@/ui/dom';

const MAX_OUTPUT = 200_000;

export class RunPanel {
  readonly el: HTMLElement;
  #out = h('pre', { class: 'run-out', tabindex: 0, 'aria-label': 'Program output', 'aria-live': 'polite' });
  #status = h('span', { class: 'muted' }, 'Idle');
  #stop = h('button', { class: 'btn small', disabled: true, onclick: () => this.stop() }, 'Stop');
  #toggle: HTMLButtonElement;
  #ctl: AbortController | null = null;
  #written = 0;

  constructor(private ctx: AppContext) {
    this.#toggle = h('button', { class: 'btn small ghost', 'aria-expanded': 'true', 'aria-label': 'Collapse output', onclick: () => this.setOpen(this.#toggle.getAttribute('aria-expanded') !== 'true') }, '▾');
    this.el = h(
      'section',
      { class: 'run-panel', hidden: true, 'aria-label': 'Run output' },
      h('div', { class: 'run-head' }, this.#toggle, h('strong', null, 'Output'), this.#status, h('span', { class: 'spacer' }), this.#stop, h('button', { class: 'btn small', onclick: () => this.clear() }, 'Clear'), h('button', { class: 'btn small ghost', 'aria-label': 'Close output', title: 'Close output', onclick: () => (this.el.hidden = true) }, '✕')),
      this.#out,
    );
    ctx.proc.signal.addEventListener('abort', () => this.stop());
  }

  get running(): boolean {
    return this.#ctl !== null;
  }

  setOpen(open: boolean): void {
    this.el.hidden = false;
    this.el.classList.toggle('collapsed', !open);
    this.#toggle.setAttribute('aria-expanded', String(open));
    this.#toggle.setAttribute('aria-label', open ? 'Collapse output' : 'Expand output');
    this.#toggle.textContent = open ? '▾' : '▸';
  }

  clear(): void {
    this.#out.replaceChildren();
    this.#written = 0;
  }

  stop(): void {
    this.#ctl?.abort();
  }

  #write(text: string, cls?: string): void {
    if (this.#written > MAX_OUTPUT) return;
    this.#written += text.length;
    if (this.#written > MAX_OUTPUT) text = text.slice(0, Math.max(0, text.length - (this.#written - MAX_OUTPUT))) + '\n[output truncated]\n';
    this.#out.append(cls ? h('span', { class: cls }, text) : text);
    this.#out.scrollTop = this.#out.scrollHeight;
  }

  async run(lang: 'js' | 'py', code: string, cwd: string): Promise<void> {
    if (this.#ctl) return;
    const ctl = (this.#ctl = new AbortController());
    this.clear();
    this.setOpen(true);
    this.#stop.disabled = false;
    this.#status.className = 'muted';
    this.#status.textContent = lang === 'py' ? 'Running (Python may take a few seconds to load)…' : 'Running…';
    // Run like any program in the box: the code in a temporary file, through the shell's js or python.
    const os = this.ctx.os;
    const file = `/tmp/editor-run-${Date.now()}.${lang}`;
    const started = performance.now();
    let r: { ok: boolean; error?: string; exitCode?: number; ms: number; value?: string };
    try {
      await os.fs.writeFile(file, code);
      const shell = await os.shells.open({ cwd });
      try {
        const exitCode = await shell.run(`${lang === 'js' ? 'js' : 'python'} '${file}'`, { out: (s) => this.#write(s), err: (s) => this.#write(s, 'err'), signal: ctl.signal });
        r = { ok: exitCode === 0 && !ctl.signal.aborted, exitCode, ms: performance.now() - started, error: ctl.signal.aborted ? 'aborted' : undefined };
      } finally {
        shell.close();
      }
    } catch (err) {
      r = { ok: false, error: ctl.signal.aborted ? 'aborted' : (err as Error).message, ms: performance.now() - started };
    } finally {
      void os.fs.rm(file).catch(() => undefined);
    }
    this.#ctl = null;
    if (this.ctx.win.closed) return;
    this.#stop.disabled = true;
    if (r.value !== undefined && r.value !== 'undefined') this.#write(`→ ${r.value}\n`, 'value');
    if (r.error) this.#write(`${r.error}\n`, 'err');
    const code_ = r.exitCode !== undefined ? ` · exit ${r.exitCode}` : '';
    this.#status.textContent = `${r.ok ? 'Finished' : r.error === 'aborted' ? 'Stopped' : 'Failed'} in ${fmtDuration(r.ms)}${code_}`;
    this.#status.className = r.ok ? 'ok' : 'err';
  }
}
