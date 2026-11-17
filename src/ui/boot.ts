import type { RemoteKernel } from '@/client/remote-kernel';
import type { KernelLogLine } from '@/kernel/types';
import { AnsiView } from './ansi-view';
import { h } from './dom';

const SETUP_DONE = 'setup.done';
const stamp = (l: KernelLogLine) => `\x1b[2m[${(l.t / 1000).toFixed(3).padStart(8)}]\x1b[0m ${l.src}: ${l.msg}\n`;

/**
 * The boot console. Shows the kernel log as the kernel starts (or the log so
 * far, when it is already running), and on first boot runs `setup` in a
 * kernel shell right here, before any GUI exists. Resolves when the system
 * is ready for the GUI; the console is then removed.
 */
export async function bootConsole(os: RemoteKernel, root: HTMLElement): Promise<void> {
  const scroller = h('div', { class: 'boot-console' });
  const view = new AnsiView('boot-out', { onFlush: () => (scroller.scrollTop = scroller.scrollHeight) });
  const prompt = h('span', { class: 'boot-prompt' });
  const input = h('input', { class: 'boot-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Answer' });
  const line = h('label', { class: 'boot-line', hidden: true }, prompt, input);
  scroller.append(view.el, line);
  scroller.addEventListener('click', () => !line.hidden && input.focus());
  root.replaceChildren(scroller);

  view.write('\x1b[1mBrowserBox\x1b[0m\n');
  await os.ready;
  // Print the log so far, then new lines until the kernel reports it is ready.
  const printed = new Set<string>();
  const print = (l: KernelLogLine) => {
    const key = `${l.t}|${l.src}|${l.msg}`;
    if (printed.has(key)) return;
    printed.add(key);
    view.write(stamp(l));
  };
  os.kernelLog.forEach(print);
  if (!os.kernelLog.some((l) => l.src === 'kernel' && l.msg === 'ready')) {
    await new Promise<void>((resolve) => {
      const off = os.bus.on('kmsg', (l) => {
        print(l);
        if (l.src === 'kernel' && l.msg === 'ready') {
          off();
          resolve();
        }
      });
    });
  }
  view.write(`\x1b[2m[  window ]\x1b[0m connected to ${os.shared ? 'the shared kernel' : 'a private kernel (no SharedWorker)'}\n`);

  if (!os.settings.get(SETUP_DONE, false)) {
    view.write('\nfirst boot\n\n');
    const shell = await os.shells.open({ cwd: '/home/user' });
    shell.onReadLine(
      (text, secret) =>
        new Promise((resolve) => {
          view.flush();
          prompt.replaceChildren();
          // The prompt may contain colour codes; render it with the same view logic.
          const p = new AnsiView('boot-prompt-text');
          p.write(text);
          p.flush();
          prompt.append(...p.el.childNodes);
          input.type = secret ? 'password' : 'text';
          input.value = '';
          line.hidden = false;
          input.focus();
          input.onkeydown = (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            line.hidden = true;
            view.write(`${text}${secret && input.value ? '••••••••' : input.value}\n`);
            resolve(input.value);
          };
        }),
    );
    await shell.run('setup', { out: (t) => view.write(t), err: (t) => view.write(`\x1b[31m${t}\x1b[0m`) });
    shell.close();
    view.flush();
  }
}
