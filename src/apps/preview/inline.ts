/**
 * Turns a multi-file site stored in the VFS into one self-contained HTML
 * document for an opaque-origin `srcdoc` iframe: local stylesheets, scripts
 * and media are inlined. Only files inside `root` (the site folder) are
 * inlined, so a page's scripts cannot pull arbitrary VFS files into reach.
 */
import type { FsApi as Vfs } from '@/kernel/api';
import { dirname, isInside, join, normalize, resolve } from '@/kernel/vfs/path';
import { mimeOf } from '../files/filetypes';

const MAX_ASSET = 15 * 1024 * 1024;
export const NAV_MESSAGE = 'browserbox-preview:navigate';

/** True for refs that point outside the VFS (http:, data:, //host, #frag, …). */
function isExternal(ref: string): boolean {
  return !ref || ref.startsWith('#') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/** Resolves a reference from `base` to a VFS path inside `root`, or null. */
export function resolveRef(root: string, base: string, ref: string): string | null {
  ref = ref.trim();
  if (isExternal(ref)) return null;
  let clean: string;
  try {
    clean = decodeURI(ref.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  if (!clean) return null;
  // "/style.css" may be a full VFS path or relative to the site root.
  const p = clean.startsWith('/') ? (isInside(root, normalize(clean)) ? normalize(clean) : join(root, clean)) : resolve(base, clean);
  return isInside(root, p) ? p : null;
}

class Inliner {
  #budget = 60 * 1024 * 1024;
  constructor(
    private fs: Vfs,
    private root: string,
  ) {}

  async #bytes(path: string): Promise<Uint8Array | null> {
    try {
      const st = await this.fs.stat(path);
      if (!st || st.kind !== 'file' || st.size > MAX_ASSET || st.size > this.#budget) return null;
      this.#budget -= st.size;
      return await this.fs.readFile(path);
    } catch {
      return null;
    }
  }

  async text(path: string): Promise<string | null> {
    const b = await this.#bytes(path);
    return b && new TextDecoder().decode(b);
  }

  async dataUrl(path: string): Promise<string | null> {
    const b = await this.#bytes(path);
    if (!b) return null;
    return new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => ok(null);
      r.readAsDataURL(new Blob([b as BlobPart], { type: mimeOf(path) }));
    });
  }

  /** Inlines `url(...)` and `@import` references in CSS, resolved from `base`. */
  async css(src: string, base: string, depth = 0): Promise<string> {
    const jobs: Array<Promise<[string, string]>> = [];
    const imports = /@import\s+(?:url\()?\s*(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/g;
    for (const m of src.matchAll(imports)) {
      const p = depth < 4 ? resolveRef(this.root, base, m[2]!) : null;
      if (p) jobs.push(this.text(p).then(async (t) => [m[0], t === null ? m[0] : (m[3]!.trim() ? `@media ${m[3]!.trim()} {\n${await this.css(t, dirname(p), depth + 1)}\n}` : await this.css(t, dirname(p), depth + 1))]));
    }
    for (const m of src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const p = resolveRef(this.root, base, m[2]!);
      if (p && !p.endsWith('.css')) jobs.push(this.dataUrl(p).then((u) => [m[0], u ? `url("${u}")` : m[0]]));
    }
    let out = src;
    for (const [from, to] of await Promise.all(jobs)) out = out.split(from).join(to);
    return out;
  }
}

/** Builds the srcdoc for `htmlPath`. `root` bounds which files may be inlined. */
export async function buildSiteDoc(fs: Vfs, htmlPath: string, html: string, root: string): Promise<string> {
  const base = dirname(htmlPath);
  const doc = new DOMParser().parseFromString(html, 'text/html'); // parsing never runs scripts
  const inl = new Inliner(fs, root);
  const jobs: Array<Promise<void>> = [];

  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i][href]')) {
    const p = resolveRef(root, base, link.getAttribute('href')!);
    if (!p) continue;
    jobs.push(
      inl.text(p).then(async (t) => {
        if (t === null) return;
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.textContent = await inl.css(t, dirname(p));
        link.replaceWith(style);
      }),
    );
  }
  for (const style of doc.querySelectorAll('style')) {
    jobs.push(inl.css(style.textContent ?? '', base).then((t) => void (style.textContent = t)));
  }
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const p = resolveRef(root, base, script.getAttribute('src')!);
    if (!p) continue;
    jobs.push(
      inl.text(p).then((t) => {
        if (t === null) return;
        script.removeAttribute('src');
        // A literal "</script" would end the inline element early.
        script.textContent = t.replace(/<\/(script)/gi, '<\\/$1');
      }),
    );
  }
  const media: Array<[string, string]> = [['img', 'src'], ['source', 'src'], ['video', 'src'], ['audio', 'src'], ['track', 'src'], ['video', 'poster'], ['input[type="image" i]', 'src'], ['link[rel~="icon" i]', 'href']];
  for (const [sel, attr] of media) {
    for (const el of doc.querySelectorAll(`${sel}[${attr}]`)) {
      const p = resolveRef(root, base, el.getAttribute(attr)!);
      if (p) jobs.push(inl.dataUrl(p).then((u) => void (u && el.setAttribute(attr, u))));
    }
  }
  await Promise.all(jobs);

  // Relative links cannot load inside srcdoc, so ask the host to navigate instead.
  const nav = doc.createElement('script');
  nav.textContent = `document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||e.defaultPrevented)return;var h=a.getAttribute('href')||'';if(!h||h[0]==='#'||h.slice(0,2)==='//'||/^[a-z][a-z0-9+.-]*:/i.test(h))return;e.preventDefault();parent.postMessage({type:${JSON.stringify(NAV_MESSAGE)},href:h},'*');});`;
  doc.head.prepend(nav);
  return `${doc.doctype ? '<!DOCTYPE html>\n' : ''}${doc.documentElement.outerHTML}`;
}
