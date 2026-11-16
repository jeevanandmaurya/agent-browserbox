import { KERNEL_URL, kernelOrigin } from '@/config/origins';

export interface KernelLink {
  port: MessagePort;
  /** Name of the Web Lock the bridge holds for as long as this window lives. */
  lock: string;
  /** False when each window runs its own kernel (no SharedWorker support). */
  shared: boolean;
}

/**
 * Connects this window to the kernel. A hidden frame served from the kernel's
 * origin starts (or joins) the kernel worker and hands back a message port.
 * Going through a frame is what lets the window live on a different origin
 * from the kernel: it never touches the kernel's storage, only this port.
 */
export function connectKernel(): Promise<KernelLink> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = new URL('bridge.html', KERNEL_URL).href;
    frame.title = 'BrowserBox kernel bridge';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    const origin = kernelOrigin();
    const timer = setTimeout(() => reject(new Error(`The kernel at ${KERNEL_URL} did not respond.`)), 20000);
    addEventListener('message', function onMessage(e: MessageEvent) {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      if (e.data?.type === 'bbx:ready') frame.contentWindow!.postMessage({ type: 'bbx:connect' }, origin);
      else if (e.data?.type === 'bbx:port' && e.ports[0]) {
        clearTimeout(timer);
        removeEventListener('message', onMessage);
        resolve({ port: e.ports[0], lock: String(e.data.lock), shared: Boolean(e.data.shared) });
      } else if (e.data?.type === 'bbx:refused') {
        clearTimeout(timer);
        reject(new Error(`The kernel refused this origin (${location.origin}). Add it to VITE_ALLOWED_ORIGINS.`));
      }
    });
    (document.body ?? document.documentElement).append(frame);
  });
}
