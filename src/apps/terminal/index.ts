import './style.css';
import { registerCommands, Shell } from '@/shell/index';
import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';

const SGR: Record<string, string> = { '1': 'a-bold', '2': 'a-dim', '31': 'a-red', '32': 'a-green', '33': 'a-yellow', '34': 'a-blue', '35': 'a-magenta', '36': 'a-cyan' };
const MAX_NODES = 6000;

const app: AppModule = {
  mount(ctx) {
    const { os, root, win, proc } = ctx;
    const screen = h('div', { class: 'term-out', 'aria-live': 'polite' });
    const promptEl = h('span', { class: 'term-prompt' });
    const input = h('input', { class: 'term-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Command line' });
    const line = h('div', { class: 'term-line' }, promptEl, input);
    const scroller = h('div', { class: 'term fill', onclick: () => !getSelection()?.toString() && input.focus() }, screen, line);
    root.append(scroller);

    // --- output: ANSI → spans, flushed once per frame ----------------------
    let pending = '';
    let scheduled = false;
    let style: string[] = [];
    const flush = () => {
      scheduled = false;
      const text = pending;
      pending = '';
      const frag = document.createDocumentFragment();
      const re = /\x1b\[([0-9;]*)m/g;
      let last = 0;
      const emit = (s: string) => {
        if (!s) return;
        frag.append(style.length ? h('span', { class: style.join(' ') }, s) : s);
      };
      for (const m of text.matchAll(re)) {
        emit(text.slice(last, m.index));
        last = m.index + m[0].length;
        for (const code of (m[1] || '0').split(';')) {
          if (code === '0' || code === '') style = [];
          else if (SGR[code]) style.push(SGR[code]);
        }
      }
      emit(text.slice(last));
      screen.append(frag);
      while (screen.childNodes.length > MAX_NODES) screen.firstChild!.remove();
      scroller.scrollTop = scroller.scrollHeight;
    };
    const write = (text: string) => {
      pending += text;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    };

    // --- line discipline ---------------------------------------------------
    let reader: ((value: string | null) => void) | null = null;
    let running: AbortController | null = null;
    let histIndex = -1;
    let draft = '';
    const shell = registerCommands(
      new Shell(os, {
        cwd: typeof ctx.args.cwd === 'string' ? ctx.args.cwd : undefined,
        ppid: proc.pid,
        tty: {
          readLine(prompt) {
            setPrompt(prompt);
            return new Promise((resolve) => (reader = resolve));
          },
          clear: () => {
            pending = '';
            screen.replaceChildren();
          },
        },
      }),
    );
    const promptText = () => {
      const home = shell.env.HOME ?? '';
      const cwd = shell.cwd === home ? '~' : shell.cwd.startsWith(home + '/') ? '~' + shell.cwd.slice(home.length) : shell.cwd;
      return `\x1b[32muser@bbx\x1b[0m \x1b[34m${cwd}\x1b[0m ❯ `;
    };
    function setPrompt(text: string | null): void {
      promptEl.replaceChildren();
      line.classList.toggle('busy', text === null);
      if (text === null) return;
      // Reuse the ANSI path so prompts can be coloured.
      let cls: string[] = [];
      let last = 0;
      for (const m of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
        if (m.index > last) promptEl.append(cls.length ? h('span', { class: cls.join(' ') }, text.slice(last, m.index)) : text.slice(last, m.index));
        last = m.index + m[0].length;
        cls = m[1] === '0' || !m[1] ? [] : [...cls, SGR[m[1]] ?? ''];
      }
      promptEl.append(text.slice(last));
    }

    async function execute(cmd: string): Promise<void> {
      write(promptText() + cmd + '\n');
      if (!cmd.trim()) return;
      if (shell.history.at(-1) !== cmd) shell.history.push(cmd);
      os.settings.set('terminal.history', shell.history.slice(-200));
      histIndex = -1;
      running = new AbortController();
      proc.signal.addEventListener('abort', () => running?.abort(), { once: true });
      setPrompt(null);
      os.procs.update(proc.pid, { state: 'running', detail: cmd.slice(0, 60) });
      const started = performance.now();
      await shell.run(cmd, { out: write, err: (t) => write(`\x1b[31m${t}\x1b[0m`), signal: running.signal });
      os.procs.account(proc.pid, performance.now() - started);
      os.procs.update(proc.pid, { state: 'idle', detail: shell.cwd });
      running = null;
      reader = null;
      if (pending && !pending.endsWith('\n')) write('\n');
      setPrompt(promptText());
      win.setTitle(`Terminal — ${shell.cwd}`);
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value;
        input.value = '';
        if (reader) {
          const r = reader;
          reader = null;
          write(promptEl.textContent + value + '\n');
          setPrompt(null);
          r(value);
        } else if (!running) void execute(value);
      } else if (e.key === 'c' && e.ctrlKey && !input.selectionEnd) {
        e.preventDefault();
        if (running) {
          running.abort();
          reader?.(null);
        } else {
          write(promptText() + input.value + '^C\n');
          input.value = '';
        }
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        shell.tty?.clear();
      } else if (e.key === 'd' && e.ctrlKey && !input.value && reader) {
        e.preventDefault();
        reader(null);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !reader && !running) {
        e.preventDefault();
        if (histIndex < 0) draft = input.value;
        const n = shell.history.length;
        histIndex = e.key === 'ArrowUp' ? (histIndex < 0 ? n - 1 : Math.max(0, histIndex - 1)) : histIndex < 0 || histIndex >= n - 1 ? -1 : histIndex + 1;
        input.value = histIndex < 0 ? draft : (shell.history[histIndex] ?? '');
        requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
      } else if (e.key === 'Tab' && !reader && !running) {
        e.preventDefault();
        const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
        void shell.complete(upto).then(({ start, options }) => {
          if (!options.length) return;
          if (options.length === 1) {
            input.value = upto.slice(0, start) + options[0] + input.value.slice(upto.length);
          } else {
            // Complete the common prefix and list the candidates.
            let prefix = options[0]!;
            for (const o of options) while (!o.startsWith(prefix)) prefix = prefix.slice(0, -1);
            if (prefix.length > upto.length - start) input.value = upto.slice(0, start) + prefix + input.value.slice(upto.length);
            else write(promptText() + input.value + '\n' + options.map((o) => o.trim()).join('  ') + '\n');
          }
        });
      }
    });

    shell.history = os.settings.get<string[]>('terminal.history', []);
    write(`\x1b[1mBrowserBox ${os.version}\x1b[0m \x1b[2m— type \x1b[0mhelp\x1b[2m for commands, \x1b[0magent\x1b[2m to talk to the AI.\x1b[0m\n`);
    setPrompt(promptText());
    input.focus();
    if (typeof ctx.args.command === 'string') void execute(ctx.args.command);
    return () => running?.abort();
  },
};
export default app;
