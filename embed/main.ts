import { connectKernel } from '@/client/connect';
import { RemoteKernel } from '@/client/remote-kernel';
import { ALLOWED_ORIGINS } from '@/config/origins';

/**
 * The runtime entry: a UI-less page that owns the kernel and lends it to one
 * embedding window over postMessage.
 *
 * This is the only page that has to be cross-origin isolated. The embedding app
 * talks to it through messages, so it never needs COOP/COEP itself and never
 * downloads the kernel, the worker or the wasm.
 *
 * The method list here is deliberately tiny: it exists to prove the boundary,
 * not to be the final SDK surface.
 */
const os = new RemoteKernel(connectKernel());
(globalThis as unknown as { bbx: RemoteKernel }).bbx = os;

const allowed = new Set(ALLOWED_ORIGINS);

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'info':
      await os.fs.ready;
      return { version: os.version, rootKind: os.rootKind, caps: os.caps.filter((c) => c.ok).map((c) => c.id) };
    case 'fs.writeFile':
      await os.fs.writeFile(String(args[0]), args[1] as string);
      return null;
    case 'fs.readText':
      return os.fs.readText(String(args[0]));
    case 'shell.run': {
      const shell = await os.shells.open();
      let out = '';
      let err = '';
      try {
        const code = await shell.run(String(args[0]), { out: (t) => (out += t), err: (t) => (err += t) });
        return { code, out, err };
      } finally {
        shell.close();
      }
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as { type?: string; id?: number; method?: string; args?: unknown[] } | null;
  if (msg?.type !== 'bbx:call' || !e.source) return;
  const reply = (body: Record<string, unknown>) => (e.source as WindowProxy).postMessage({ type: 'bbx:result', id: msg.id, ...body }, e.origin);
  if (!allowed.has(e.origin)) return reply({ ok: false, error: `Origin ${e.origin} is not allowed. Add it to VITE_ALLOWED_ORIGINS.` });
  void invoke(String(msg.method), Array.isArray(msg.args) ? msg.args : []).then(
    (value) => reply({ ok: true, value }),
    (err: Error) => reply({ ok: false, error: err.message }),
  );
});

if (parent !== window) parent.postMessage({ type: 'bbx:embed-ready' }, '*');
