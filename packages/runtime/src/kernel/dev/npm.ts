/**
 * npm packages without npm: bare imports (`react`, `lodash/debounce`) are
 * fetched as ES modules from esm.sh and bundled into the app. Versions come
 * from the project's package.json; everything fetched is kept in Cache
 * Storage, so a project that built once keeps building offline.
 */

export const ESM_CDN = 'https://esm.sh';
const CACHE = 'bbx-npm';

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** `@scope/pkg/sub/path` → ['@scope/pkg', '/sub/path']. */
export function splitSpecifier(spec: string): [string, string] {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return [parts.slice(0, n).join('/'), parts.length > n ? '/' + parts.slice(n).join('/') : ''];
}

/** An exact version from a package.json range (`^18.3.1` → `18.3.1`), or null for tags, paths and git URLs. */
export function pinVersion(range: string): string | null {
  const m = /^[\^~=v>]*\s*(\d+(?:\.\d+){0,2}(?:-[\w.]+)?)$/.exec(range.trim());
  return m ? m[1]! : null;
}

export class Npm {
  readonly versions: Record<string, string> = {};

  constructor(pkg: PackageJson | null, private dev = true) {
    for (const [name, range] of Object.entries({ ...pkg?.devDependencies, ...pkg?.dependencies })) {
      const v = pinVersion(range);
      if (v) this.versions[name] = v;
    }
  }

  /** The esm.sh URL for a bare specifier. */
  url(spec: string): string {
    const [name, sub] = splitSpecifier(spec);
    const v = this.versions[name];
    const at = `${ESM_CDN}/${name}${v ? `@${v}` : ''}${sub}`;
    // Stylesheets and other files are served as they are.
    if (/\.(css|json|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(sub)) return at;
    return `${at}?target=es2022${this.dev ? '&dev' : ''}`;
  }

  /**
   * One copy of each dependency: esm.sh modules import their own dependencies
   * by absolute path, possibly at another version (react-dom@18.2 asks for the
   * newest react 18). Paths to a package listed in package.json are rewritten
   * to its pinned version, and build-variant segments (/X-…/) dropped, so
   * everything shares one module (two Reacts break hooks).
   */
  canonical(url: string): string {
    const u = new URL(url);
    if (u.origin !== ESM_CDN) return url;
    const m = /^\/(?:v\d+\/)?((?:@[^/]+\/)?[^/@]+)@([^/]+)(\/X-[^/]+)?(\/.*)?$/.exec(u.pathname);
    if (!m) return url;
    const [, name, version, , rest = ''] = m as unknown as [string, string, string, string | undefined, string | undefined];
    const pinned = this.versions[name] ?? version;
    u.pathname = `/${name}@${pinned}${rest}`;
    return u.href;
  }
}

const memory = new Map<string, Promise<string>>();

/** Fetches a module's source: memory, then Cache Storage, then the network. */
export function fetchModule(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  let p = memory.get(url);
  if (!p) {
    p = (async () => {
      const cache = await globalThis.caches?.open(CACHE).catch(() => null);
      const hit = await cache?.match(url);
      if (hit) return hit.text();
      let res: Response;
      try {
        res = await fetcher(url);
      } catch {
        throw new Error(`could not download ${url} (offline?)`);
      }
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}${res.status === 404 ? ' (is the package name right?)' : ''}`);
      const text = await res.text();
      await cache?.put(url, new Response(text, { headers: { 'content-type': res.headers.get('content-type') ?? 'text/javascript' } })).catch(() => undefined);
      return text;
    })();
    memory.set(url, p);
    p.catch(() => memory.delete(url));
  }
  return p;
}
