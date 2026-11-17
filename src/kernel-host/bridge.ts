import { RemoteKernel } from '@/client/remote-kernel';
import { ALLOWED_ORIGINS } from '@/config/origins';
import { runJs, runPython, runWasm, type RunResult } from '@/sandbox/sandbox';

/**
 * The kernel bridge: a hidden page on the kernel's origin, embedded by every
 * BrowserBox window. It does three things:
 *  1. starts or joins the kernel worker;
 *  2. gives the embedding window a message port to it (after checking origin);
 *  3. hosts sandbox frames for the kernel, which has no document of its own.
 */
const shared = 'SharedWorker' in globalThis;
let dedicated: Worker | null = null;

function kernelPort(): MessagePort {
  // Every window constructs the same SharedWorker and so reaches the one running kernel.
  if (shared) return new SharedWorker(new URL('../kernel-worker/main.ts', import.meta.url), { type: 'module', name: 'bbx-kernel' }).port;
  dedicated ??= new Worker(new URL('../kernel-worker/main.ts', import.meta.url), { type: 'module', name: 'bbx-kernel' });
  const ch = new MessageChannel();
  dedicated.postMessage({ type: 'connect' }, [ch.port2]);
  return ch.port1;
}

// Held until this frame is destroyed; the kernel waits on it to learn that the window closed.
const lock = `bbx-window-${crypto.randomUUID()}`;
void navigator.locks?.request(lock, () => new Promise(() => undefined));

// --- sandbox host ------------------------------------------------------------
const os = new RemoteKernel(Promise.resolve({ port: kernelPort(), lock, shared }), 'host');
const aborts = new Map<number, AbortController>();
interface Job {
  code: string;
  wasm: Uint8Array;
  args?: string[];
  network?: boolean;
  ppid?: number;
  packages?: string[];
  stdin?: string;
  name?: string;
}
void os.handle({
  'host.run': async (runId: number, kind: 'js' | 'python' | 'wasm', p: Job, o: { cwd?: string; timeoutMs?: number }): Promise<RunResult> => {
    const ctl = new AbortController();
    aborts.set(runId, ctl);
    const peer = await os.handle({});
    const opts = { ...o, signal: ctl.signal, onStdout: (t: string) => peer.emit('host:out', { runId, s: 'o', t }), onStderr: (t: string) => peer.emit('host:out', { runId, s: 'e', t }) };
    try {
      if (kind === 'js') return await runJs(os, p.code, { ...opts, args: p.args, network: p.network, ppid: p.ppid });
      if (kind === 'python') return await runPython(os, p.code, { ...opts, packages: p.packages });
      return await runWasm(os, p.wasm, { ...opts, args: p.args, stdin: p.stdin, name: p.name, ppid: p.ppid });
    } finally {
      aborts.delete(runId);
    }
  },
}).then((peer) => peer.on<number>('host:abort', (runId) => aborts.get(runId)?.abort()));

// --- port handoff to the embedding window --------------------------------------
const allowed = new Set([location.origin, ...ALLOWED_ORIGINS]);
let handed = false;
addEventListener('message', (e) => {
  // The window may ask twice (once eagerly, once on our ready signal); answer once.
  if (e.source !== parent || e.data?.type !== 'bbx:connect' || handed) return;
  if (!allowed.has(e.origin)) return parent.postMessage({ type: 'bbx:refused' }, e.origin);
  handed = true;
  parent.postMessage({ type: 'bbx:port', lock, shared }, e.origin, [kernelPort()]);
});
if (parent !== window) parent.postMessage({ type: 'bbx:ready' }, '*');
