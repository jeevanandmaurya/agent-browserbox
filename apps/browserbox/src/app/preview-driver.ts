import type { RemoteKernel, WireRequest, DevLog } from '@jeevanand/agent-browserbox-runtime/client';
import { dirname } from '@jeevanand/agent-browserbox-runtime/client';
import { htmlFrame } from '@/apps/preview/views';
import { buildSiteDoc, NAV_MESSAGE, resolveRef } from '@/apps/preview/inline';
import { previewStore } from './preview-storage';
import AUTO from './preview-auto.js?raw';

/**
 * Pages the agent drives with its `preview` tool: one per chat, in the same
 * sandboxed frame as Preview (so it can only touch its own page), held by
 * the window that answers the agent. The frame is in the window, invisible
 * but on screen, so the page renders and its timers and animations run.
 */
export interface DriverResult {
  text: string;
  /** A screenshot, saved as a PNG in the box. */
  image?: string;
}

interface Page {
  frame: HTMLIFrameElement;
  title: string;
  /** What is open: a file in the box, or a dev server's page. */
  target: { kind: 'file'; path: string; root: string } | { kind: 'dev'; port: number; path: string };
  ready: Promise<void>;
  pending: Map<number, { ok: (v: { result?: unknown; errors?: string[] }) => void; no: (e: Error) => void }>;
}

const VIEW = { width: 1280, height: 800 };
const TIMEOUT = 30_000;
let stage: HTMLElement | null = null;
let shots = 0;

function stageEl(): HTMLElement {
  if (stage?.isConnected) return stage;
  stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  // On screen (off-screen frames are throttled), but invisible and out of the way.
  Object.assign(stage.style, { position: 'fixed', left: '0', top: '0', width: `${VIEW.width}px`, height: `${VIEW.height}px`, opacity: '0', pointerEvents: 'none', zIndex: '-1', overflow: 'hidden' });
  document.body.append(stage);
  return stage;
}

/** The page with the automation script first, so it sees everything the page does. */
function withAuto(html: string): string {
  const tag = `<script>${AUTO}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
}

export class PreviewDriver {
  #pages = new Map<string, Page>();
  #seq = 0;

  constructor(private os: RemoteKernel) {}

  async run(sid: string, action: string, args: Record<string, unknown>): Promise<DriverResult> {
    if (action === 'open') return this.#open(sid, String(args.target ?? ''));
    if (action === 'close') {
      this.#pages.get(sid)?.frame.remove();
      this.#pages.delete(sid);
      return { text: 'closed' };
    }
    const page = this.#pages.get(sid);
    if (!page) throw new Error('no page is open: use action "open" with a file path or a dev server address first');
    await page.ready;
    const r = await this.#ask(page, action, args);
    const errors = r.errors?.length ? `\n\nErrors on the page:\n${r.errors.join('\n')}` : '';
    if (action === 'screenshot') {
      const shot = r.result as { image: string; width: number; height: number };
      const bytes = Uint8Array.from(atob(shot.image.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
      const path = `/tmp/preview/${sid.slice(-8)}-${++shots}.png`;
      await this.os.fs.writeFile(path, bytes);
      return { text: `Screenshot of ${page.title} (${shot.width}×${shot.height}), saved at ${path}.${errors}`, image: path };
    }
    return { text: `${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}${errors}` };
  }

  /** Opens a file of the box (`/home/agent/app/index.html`) or a dev server's page (`http://localhost:3000/`). */
  async #open(sid: string, target: string): Promise<DriverResult> {
    const dev = /^https?:\/\/localhost:(\d+)(\/[^\s]*)?$/.exec(target);
    if (dev) return this.#load(sid, { kind: 'dev', port: Number(dev[1]), path: dev[2] || '/' });
    if (!target.startsWith('/')) throw new Error('open needs an absolute file path or http://localhost:<port>/…');
    const st = await this.os.fs.stat(target);
    if (!st) throw new Error(`${target} does not exist`);
    const path = st.kind === 'dir' ? `${target.replace(/\/+$/, '')}/index.html` : target;
    return this.#load(sid, { kind: 'file', path, root: st.kind === 'dir' ? target.replace(/\/+$/, '') : dirname(path) });
  }

  async #load(sid: string, target: Page['target']): Promise<DriverResult> {
    this.#pages.get(sid)?.frame.remove();
    let html: string;
    let store;
    if (target.kind === 'dev') {
      const info = (await this.os.dev.list()).find((d) => d.port === target.port);
      if (!info) throw new Error(`no dev server on port ${target.port} (start one with dev_server)`);
      html = (await this.os.dev.page(target.port, target.path)).html;
      store = previewStore(this.os, `dev:${info.root}`);
    } else {
      html = await buildSiteDoc(this.os.fs, target.path, await this.os.fs.readText(target.path), target.root);
      store = previewStore(this.os, `site:${target.root}`);
    }
    const pending: Page['pending'] = new Map();
    let ready!: () => void;
    const page: Page = { frame: null as unknown as HTMLIFrameElement, title: target.path, target, ready: new Promise((r) => (ready = r)), pending };
    page.frame = htmlFrame(
      withAuto(html),
      'Agent preview',
      (data, reply) => {
        if (data.type === 'bbx-auto:ready') {
          page.title = String(data.title || target.path);
          ready();
        } else if (data.type === 'bbx-auto:res') {
          const w = pending.get(Number(data.id));
          pending.delete(Number(data.id));
          if (data.error) w?.no(new Error(String(data.error)));
          else w?.ok({ result: data.result, errors: data.errors as string[] | undefined });
        } else if (data.type === 'bbx-dev:req' && target.kind === 'dev') {
          // The page's own requests go to its dev server, as in Preview.
          void this.os.dev.request(target.port, data.req as WireRequest).then(
            (res) => reply({ type: 'bbx-dev:res', id: data.id, res }, res.body ? [res.body.buffer] : []),
            (err: Error) => reply({ type: 'bbx-dev:res', id: data.id, error: err.message }),
          );
        } else if (data.type === 'bbx-dev:log' && target.kind === 'dev') {
          this.os.dev.log(target.port, [data.entry as Pick<DevLog, 'level' | 'source' | 'text'>]);
        } else if (data.type === 'bbx-dev:nav' && target.kind === 'dev') {
          void this.#load(sid, { ...target, path: String(data.path || '/') });
        } else if (data.type === NAV_MESSAGE && target.kind === 'file') {
          const next = resolveRef(target.root, dirname(target.path), String(data.href));
          if (next) void this.#load(sid, { ...target, path: next });
        }
      },
      store,
    );
    Object.assign(page.frame.style, { width: `${VIEW.width}px`, height: `${VIEW.height}px`, border: '0' });
    stageEl().append(page.frame);
    this.#pages.set(sid, page);
    const loaded = await Promise.race([page.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
    if (!loaded) throw new Error(`the page did not finish loading in 15 s: ${target.kind === 'dev' ? `localhost:${target.port}${target.path}` : target.path}`);
    const first = await this.#ask(page, 'snapshot', {});
    const errors = first.errors?.length ? `\n\nErrors on the page:\n${first.errors.join('\n')}` : '';
    const logs = await this.#ask(page, 'console', {});
    return { text: `Opened ${target.kind === 'dev' ? `http://localhost:${target.port}${target.path}` : target.path}.\n\n${first.result}${errors}${logs.result && logs.result !== '(no console output)' ? `\n\nConsole while loading:\n${logs.result}` : ''}` };
  }

  #ask(page: Page, action: string, args: Record<string, unknown>): Promise<{ result?: unknown; errors?: string[] }> {
    const id = ++this.#seq;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        page.pending.delete(id);
        no(new Error(`the page did not answer "${action}" within ${TIMEOUT / 1000} s (busy, or it navigated away)`));
      }, TIMEOUT);
      page.pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), no: (e) => (clearTimeout(timer), no(e)) });
      page.frame.contentWindow?.postMessage({ type: 'bbx-auto:do', id, action, args }, '*');
    });
  }
}
