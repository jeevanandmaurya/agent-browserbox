import { KERNEL_URL } from '@/config/origins';

export interface ConnectOptions {
  /** Where the kernel is served. Defaults to the build-time KERNEL_URL. */
  kernelUrl?: string;
}

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
export function connectKernel(opts: ConnectOptions = {}): Promise<KernelLink> {
  const kernelUrl = opts.kernelUrl ?? KERNEL_URL;
  const base = kernelUrl.endsWith('/') ? kernelUrl : `${kernelUrl}/`;
  const origin = new URL(base).origin;
  return new Promise((resolve, reject) => {
    const src = new URL('bridge.html', base).href;
    // The page's HTML normally pre-starts the bridge so the kernel boots in parallel with our script.
    const early = document.getElementById('bbx-bridge') as HTMLIFrameElement | null;
    const frame = early?.src === src ? early : document.createElement('iframe');
    if (frame !== early) {
      frame.src = src;
      frame.title = 'BrowserBox kernel bridge';
      frame.setAttribute('aria-hidden', 'true');
      frame.hidden = true;
    }
    const timer = setTimeout(() => reject(new Error(`The kernel at ${base} did not respond.`)), 20000);
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
    if (frame === early) frame.contentWindow?.postMessage({ type: 'bbx:connect' }, origin); // it may already be listening
    else (document.body ?? document.documentElement).append(frame);
  });
}
