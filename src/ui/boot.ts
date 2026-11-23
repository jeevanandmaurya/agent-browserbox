import { agentsOf } from '@/app/agents';
import type { RemoteKernel } from '@/client/remote-kernel';
import type { KernelLogLine } from '@/kernel/types';
import { Terminal } from './terminal';

const SETUP_DONE = 'setup.done';
const stamp = (l: KernelLogLine) => `\x1b[2m[${(l.t / 1000).toFixed(3).padStart(8)}]\x1b[0m ${l.src}: ${l.msg}\n`;

/**
 * The boot console. Shows the kernel log as the kernel starts (or the log so
 * far, when it is already running), and on first boot runs `setup` in a
 * kernel shell right here, before any GUI exists. Resolves when the system
 * is ready for the GUI; the console is then removed.
 */
export async function bootConsole(os: RemoteKernel, root: HTMLElement): Promise<void> {
  const term = new Terminal({ cls: 'boot-console', maxLines: 2000 });
  root.replaceChildren(term.el);

  term.write('\x1b[1mBrowserBox\x1b[0m\n');
  await os.ready;
  // Print the log so far, then new lines until the kernel reports it is ready.
  const printed = new Set<string>();
  const print = (l: KernelLogLine) => {
    const key = `${l.t}|${l.src}|${l.msg}`;
    if (printed.has(key)) return;
    printed.add(key);
    term.write(stamp(l));
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
  term.write(`\x1b[2m[  window ]\x1b[0m connected to ${os.shared ? 'the shared kernel' : 'a private kernel (no SharedWorker)'}\n`);

  if (!os.settings.get(SETUP_DONE, false)) {
    // `setup` is the agent's command: wait until the agent worker has offered it.
    await agentsOf(os).live().catch(() => []);
    term.write('\nfirst boot\n\n');
    const shell = await os.shells.open({ cwd: '/home/user' });
    term.attach(shell);
    await term.run(shell, 'setup');
    shell.close();
  }
}
