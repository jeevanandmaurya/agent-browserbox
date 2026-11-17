/** Per-type preview renderers. Each returns the element to show. */
import { PREVIEW_FRAME_URL } from '@/config/origins';
import { h } from '@/ui/dom';

const MAX_TEXT = 2 * 1024 * 1024;
const HEX_BYTES = 64 * 1024;

const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

/**
 * Untrusted HTML runs in an opaque origin: never add allow-same-origin here.
 * The frame loads a small page with its own (permissive) policy and receives
 * the document by message, so the page's scripts run without inheriting the
 * BrowserBox window's script restrictions. `onMessage` gets the page's other messages.
 */
export function htmlFrame(html: string, title: string, onMessage?: (data: { type?: string } & Record<string, unknown>, reply: (msg: unknown, transfer?: Transferable[]) => void) => void): HTMLIFrameElement {
  const frame = h('iframe', { class: 'pv-frame', title, referrerPolicy: 'no-referrer' });
  frame.setAttribute('sandbox', SANDBOX);
  frame.setAttribute('allow', 'fullscreen; clipboard-write; autoplay');
  const reply = (msg: unknown, transfer: Transferable[] = []) => frame.contentWindow?.postMessage(msg, '*', transfer);
  const listener = (e: MessageEvent) => {
    if (!frame.isConnected) return removeEventListener('message', listener);
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'bbx-preview:ready') {
      frame.dataset.loaded = '1';
      reply({ type: 'bbx-preview:doc', html });
    } else onMessage?.(e.data, reply);
  };
  addEventListener('message', listener);
  frame.src = PREVIEW_FRAME_URL;
  return frame;
}

export function textView(bytes: Uint8Array): HTMLElement {
  const cut = bytes.length > MAX_TEXT;
  const text = new TextDecoder().decode(cut ? bytes.subarray(0, MAX_TEXT) : bytes);
  return h(
    'div',
    { class: 'pv-scroll' },
    cut && h('p', { class: 'pv-note' }, `Showing the first 2 MB of ${(bytes.length / 1048576).toFixed(1)} MB.`),
    h('pre', { class: 'pv-text', tabindex: 0, 'aria-label': 'File contents' }, text),
  );
}

export function hexView(bytes: Uint8Array): HTMLElement {
  const n = Math.min(bytes.length, HEX_BYTES);
  const rows: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return h(
    'div',
    { class: 'pv-scroll' },
    h('p', { class: 'pv-note' }, `Binary file · ${bytes.length.toLocaleString()} bytes${bytes.length > n ? ` · showing the first ${n / 1024} KB` : ''}`),
    h('pre', { class: 'pv-text', tabindex: 0, 'aria-label': 'Hex dump' }, rows.join('\n')),
  );
}

/** Image with fit / zoom controls driven from the toolbar. */
export class ImageView {
  readonly el: HTMLElement;
  readonly img: HTMLImageElement;
  /** null = fit to window. */
  zoom: number | null = null;
  onChange: () => void = () => {};

  constructor(url: string, alt: string) {
    this.img = h('img', { src: url, alt, draggable: false });
    this.el = h('div', { class: 'pv-image fit', tabindex: 0, 'aria-label': `Image: ${alt}` }, this.img);
    this.img.addEventListener('load', () => this.onChange());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.step(1);
      else if (e.key === '-') this.step(-1);
      else if (e.key === '0') this.set(null);
      else if (e.key === '1') this.set(1);
      else return;
      e.preventDefault();
    });
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.step(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }

  /** The effective scale, also when fitted. */
  get scale(): number {
    if (this.zoom !== null) return this.zoom;
    const w = this.img.naturalWidth;
    return w ? this.img.clientWidth / w : 1;
  }

  set(z: number | null): void {
    this.zoom = z === null ? null : Math.min(16, Math.max(0.05, z));
    this.el.classList.toggle('fit', this.zoom === null);
    const w = this.img.naturalWidth || 300;
    this.img.style.width = this.zoom === null ? '' : `${Math.round(w * this.zoom)}px`;
    this.onChange();
  }

  step(dir: 1 | -1): void {
    this.set(dir > 0 ? this.scale * 1.25 : this.scale / 1.25);
  }
}
