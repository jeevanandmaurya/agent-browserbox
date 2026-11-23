import '../ui/base.css';
import { appKernel } from '@/app/boot';
import type { RemoteKernel } from '@/client/remote-kernel';
import { createDesktop } from '@/ui/desktop';
import { bootConsole } from '@/ui/boot';
import { followTheme } from '@/ui/standalone';

/**
 * The desktop GUI: one optional frontend for the kernel. It owns no state —
 * closing this window leaves the kernel, running agents and shells untouched,
 * and any other frontend could take its place by speaking the same protocol.
 */
const os = appKernel();
followTheme(os);
os.mark('page');

void bootConsole(os, document.getElementById('desk')!).then(
  () => {
    const apps = createDesktop(os, document.getElementById('desk')!);
    // Announces that a desktop is available, so other windows route "open app" requests here.
    const proc = os.procs.spawn({ name: 'desktop', kind: 'service', detail: 'window manager' });
    os.procs.update(proc.pid, { state: 'idle' });
    os.mark('ready');
    const params = new URLSearchParams(location.search);
    const app = params.get('app');
    if (app) void apps.launch(app);
  },
  (err: Error) => {
    document.getElementById('desk')!.textContent = `BrowserBox could not start: ${err.message}`;
  },
);

if ('serviceWorker' in navigator && import.meta.env.PROD) addEventListener('load', () => void navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => undefined));
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;
