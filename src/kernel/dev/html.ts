import { mimeOf } from '@/apps/files/filetypes';
import { dirname, isInside, join, normalize, resolve } from '@/kernel/vfs/path';
import type { BuildFs, BundleInput, BundleOutput } from './bundle';
import { dataUrl } from './bundle';
import shimSrc from './shim.js?raw';
import type { DevPage } from './types';

/**
 * Turns a project's HTML page into one self-contained document for Preview:
 * module scripts are bundled and inlined, stylesheets and images inlined, and
 * a small runtime is put first so the page's requests, console output and
 * link clicks reach the dev server. Plain string rewriting: the kernel has no DOM.
 */

const MAX_INLINE_ASSET = 8 * 1024 * 1024;
const TAG_ATTRS = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function attrs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(TAG_ATTRS)) out.set(m[1]!.toLowerCase(), (m[2] ?? '').replace(/^["']|["']$/g, ''));
  return out;
}

/** Safe inside an inline `<script>` or `<style>`: nothing in it can end the element early. */
const inline = (code: string, tag: 'script' | 'style') => code.replace(new RegExp(`</(${tag})`, 'gi'), `<\\/$1`);

const isLocal = (ref: string) => !!ref && !ref.startsWith('#') && !ref.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(ref);

/** A project path for a reference in the page, kept inside the project folder. */
function local(root: string, base: string, ref: string): string | null {
  if (!isLocal(ref)) return null;
  let clean: string;
  try {
    clean = decodeURI(ref.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  const p = clean.startsWith('/') ? (isInside(root, normalize(clean)) && root !== '/' ? normalize(clean) : join(root, clean)) : resolve(base, clean);
  return isInside(root, p) ? p : null;
}

const DEFAULT_ENTRIES = ['src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js', 'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js', 'main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts', 'index.jsx', 'index.js', 'app.js'];

/** A page for projects with code but no index.html, the way a framework template would. */
async function defaultPage(fs: BuildFs, root: string): Promise<string | null> {
  for (const e of DEFAULT_ENTRIES) {
    if ((await fs.stat(join(root, e)).catch(() => null))?.kind === 'file') {
      return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>App</title>\n</head>\n<body>\n<div id="root"></div>\n<div id="app"></div>\n<script type="module" src="/${e}"></script>\n</body>\n</html>\n`;
    }
  }
  return null;
}

export interface RenderOptions {
  root: string;
  /** The HTML file, or null to generate a page for a `src/main.*` entry. */
  htmlPath: string | null;
  /** Page source to use instead of reading htmlPath. */
  html?: string;
  /** The address the page believes it is at (for client-side routers). */
  path: string;
  port: number;
  /** Leave out the dev runtime (request forwarding, console capture): for a production build. */
  runtime?: boolean;
  bundle(entry: BundleInput['entry']): Promise<BundleOutput>;
}

export async function renderHtml(fs: BuildFs, o: RenderOptions): Promise<DevPage & { inputs: string[] }> {
  const errors: string[] = [];
  const inputs = new Set<string>();
  const css: string[] = [];
  let html = o.html !== undefined ? o.html : o.htmlPath ? new TextDecoder().decode(await fs.readFile(o.htmlPath)) : await defaultPage(fs, o.root);
  if (html === null) {
    html = `<!doctype html><meta charset="utf-8"><title>Nothing to serve</title><body style="font:15px system-ui;padding:24px"><h1 style="font-size:18px">Nothing to serve yet</h1><p>Add an <code>index.html</code> (or <code>src/main.tsx</code>) to ${o.root}.</p>`;
  }
  if (o.htmlPath) inputs.add(o.htmlPath);
  const base = o.htmlPath ? dirname(o.htmlPath) : o.root;
  const take = (out: BundleOutput) => {
    errors.push(...out.errors);
    out.inputs.forEach((i) => inputs.add(i));
    if (out.css) css.push(out.css);
    return out.js;
  };

  // Scripts: modules are bundled; classic local scripts are inlined as they are.
  const jobs: Array<Promise<[string, string]>> = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const a = attrs(m[1]!);
    const type = (a.get('type') ?? '').toLowerCase();
    const src = a.get('src');
    const path = src ? local(o.root, base, src) : null;
    if (type === 'module') {
      if (src && !path) continue; // a module from another site: the browser loads it
      const entry = path ?? { contents: m[2]!, dir: base, name: `${o.htmlPath ?? 'index.html'} (inline module)` };
      jobs.push(o.bundle(entry).then((out) => [m[0], `<script type="module">\n${inline(take(out), 'script')}\n</script>`]));
    } else if (path && (!type || /javascript|ecmascript/.test(type))) {
      jobs.push(
        fs.readFile(path).then(
          (b) => (inputs.add(path), [m[0], `<script>\n${inline(new TextDecoder().decode(b), 'script')}\n</script>`]),
          () => (errors.push(`${src}: not found`), [m[0], '']),
        ),
      );
    }
  }
  // Stylesheets go through the bundler too, for @import and url().
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrs(m[1]!);
    const rel = (a.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = a.get('href') ?? '';
    const path = local(o.root, base, href);
    if (!path) continue;
    if (rel.includes('stylesheet')) {
      const media = a.get('media');
      const style = (code: string) => `<style${media ? ` media="${media}"` : ''}>\n${inline(code, 'style')}\n</style>`;
      jobs.push(
        fs.readFile(path).then(
          async (b) => {
            inputs.add(path);
            const code = new TextDecoder().decode(b);
            // Only stylesheets that pull in other files need the bundler (and its download).
            if (!/@import|url\(/i.test(code)) return [m[0], style(code)];
            const out = await o.bundle(path);
            take({ ...out, css: '' });
            return [m[0], style(out.css)];
          },
          () => (errors.push(`${href}: not found`), [m[0], '']),
        ),
      );
    } else if (rel.includes('modulepreload') || rel.includes('preload')) {
      jobs.push(Promise.resolve([m[0], '']));
    } else if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('manifest')) {
      jobs.push(asset(path).then((u) => [m[0], u ? m[0].replace(href, u) : m[0]]));
    }
  }
  // Images and media referenced by the page.
  for (const m of html.matchAll(/<(img|source|video|audio|track|input)\b[^>]*?\s(src|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const ref = m[4] ?? m[5] ?? '';
    const path = local(o.root, base, ref);
    if (path) jobs.push(asset(path).then((u) => [m[0], u ? m[0].replace(m[3]!, `"${u}"`) : m[0]]));
  }
  async function asset(path: string): Promise<string | null> {
    const st = await fs.stat(path).catch(() => null);
    if (st?.kind !== 'file') return null;
    const bytes = await fs.readFile(path);
    if (bytes.length > MAX_INLINE_ASSET) return null;
    inputs.add(path);
    return dataUrl(bytes, mimeOf(path));
  }

  for (const [from, to] of await Promise.all(jobs)) html = html.replace(from, () => to);

  const config = { port: o.port, path: o.path, errors };
  const style = css.length ? `\n<style>\n${inline(css.join('\n'), 'style')}\n</style>` : '';
  const head = o.runtime === false ? style : `<script>window.__bbxDev=${inline(JSON.stringify(config), 'script')};\n${shimSrc}</script>${style}`;
  // The runtime must run before any of the page's own scripts.
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${head}`);
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, (h) => `${h}<head>${head}</head>`);
  else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, (d) => `${d}\n${head}`);
  else html = head + html;
  return { html, errors, inputs: [...inputs] };
}
