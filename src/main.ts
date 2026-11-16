import './ui/base.css';
import { Kernel } from './kernel/kernel';
import { createDesktop } from './ui/desktop';

/**
 * Boot sequence. The kernel and desktop are built synchronously so the first
 * frame is the usable desktop; storage, WASM and the service worker come up
 * afterwards without blocking it. Apps are code-split and load on demand.
 */
const os = new Kernel();
document.documentElement.dataset.theme = os.settings.get('ui.theme', 'dark');
os.bus.on('settings:change', ({ key, value }) => {
  if (key === 'ui.theme') document.documentElement.dataset.theme = String(value ?? 'dark');
});

const apps = createDesktop(os, document.getElementById('desk')!);
os.mark('desktop');
requestAnimationFrame(() => os.mark('first-frame'));

void os.start().then(() => {
  os.mark('ready');
  if (!os.settings.get('ui.welcomed', false)) {
    os.settings.set('ui.welcomed', true);
    void apps.launch('agent');
  }
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}

// Handy for debugging from the browser console.
(globalThis as unknown as { bbx: Kernel }).bbx = os;
