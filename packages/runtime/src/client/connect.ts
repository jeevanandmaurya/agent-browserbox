import { KERNEL_URL } from '../config/origins';
import { APP_KERNEL, toSearch, type KernelInstance } from '../kernel/instance';

export interface ConnectOptions {
  /** Where the kernel is served. Defaults to the build-time KERNEL_URL. */
  kernelUrl?: string;
  /** Which kernel: the app's (default) or an SDK box. */
  instance?: KernelInstance;
}

export interface KernelLink {
  port: MessagePort;
  /** Name of the Web Lock the bridge holds for as long as this window lives. */
  lock: string;
  /** False when each window runs its own kernel (no SharedWorker support). */
  shared: boolean;
  /** Asks the same bridge for one more port to the same kernel (a separate client). */
  more?(): Promise<KernelLink>;
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
    const src = new URL(`bridge.html${toSearch(opts.instance ?? APP_KERNEL)}`, base).href;
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
    let nextReq = 1;
    const waiting = new Map<number, (link: KernelLink) => void>();
    const link = (data: { lock: unknown; shared: unknown }, port: MessagePort): KernelLink => ({
      port,
      lock: String(data.lock),
      shared: Boolean(data.shared),
      more: () =>
        new Promise<KernelLink>((res) => {
          const req = nextReq++;
          waiting.set(req, res);
          frame.contentWindow!.postMessage({ type: 'bbx:connect', req }, origin);
        }),
    });
    let first = true;
    addEventListener('message', (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== origin) return;
      if (e.data?.type === 'bbx:ready' && first) frame.contentWindow!.postMessage({ type: 'bbx:connect' }, origin);
      else if (e.data?.type === 'bbx:port' && e.ports[0]) {
        if (typeof e.data.req === 'number') {
          waiting.get(e.data.req)?.(link(e.data, e.ports[0]));
          waiting.delete(e.data.req);
        } else if (first) {
          first = false;
          clearTimeout(timer);
          resolve(link(e.data, e.ports[0]));
        }
      } else if (e.data?.type === 'bbx:refused' && first) {
        clearTimeout(timer);
        reject(new Error(`The kernel refused this origin (${location.origin}). Add it to VITE_ALLOWED_ORIGINS.`));
      }
    });
    if (frame === early) frame.contentWindow?.postMessage({ type: 'bbx:connect' }, origin); // it may already be listening
    else (document.body ?? document.documentElement).append(frame);
  });
}
