/** Address-bar parsing: turns what the user typed into something we can open. */

export type Target =
  | { kind: 'start' }
  | { kind: 'web'; url: string }
  | { kind: 'vfs'; path: string }
  | { kind: 'error'; input: string; reason: string };

export const SEARCH = 'https://duckduckgo.com/?q=';

const HOSTLIKE = /^(localhost|[\w-]+(\.[\w-]+)+|\[[\da-f:]+\])(:\d+)?([/?#]|$)/i;
const LOCAL = /^(localhost|127(\.\d+){3}|\[::1\])(:\d+)?([/?#]|$)/i;

export function resolveInput(raw: string): Target {
  const s = raw.trim();
  if (!s || /^about:(start|home|blank|newtab)$/i.test(s)) return { kind: 'start' };
  if (/^vfs:/i.test(s)) return vfs(s.slice(4));
  if (s.startsWith('/')) return vfs(s);
  if (/^https?:\/\//i.test(s)) return web(s);
  if (/\s/.test(s)) return search(s);
  if (HOSTLIKE.test(s)) return web((LOCAL.test(s) ? 'http://' : 'https://') + s);
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(s);
  if (scheme) return { kind: 'error', input: s, reason: `“${scheme[1]}:” links can't be opened here. Only http(s) addresses and vfs: paths are supported.` };
  return search(s);
}

function web(s: string): Target {
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return { kind: 'web', url: u.href };
  } catch {
    return { kind: 'error', input: s, reason: 'That is not a valid web address.' };
  }
}

function search(q: string): Target {
  return { kind: 'web', url: SEARCH + encodeURIComponent(q) };
}

function vfs(p: string): Target {
  let path: string;
  try {
    path = decodeURIComponent(p);
  } catch {
    path = p;
  }
  path = '/' + path.replace(/^\/+/, '');
  return { kind: 'vfs', path };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Same-origin pages must never be framed with allow-same-origin: they would get our storage. */
export function isSameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === location.origin;
  } catch {
    return false;
  }
}

/** Mixed content: an http page cannot load inside an https app. */
export function isMixedContent(url: string): boolean {
  return location.protocol === 'https:' && url.startsWith('http:') && !LOCAL.test(url.slice(7));
}

// Popular sites known to send X-Frame-Options / frame-ancestors. Not exhaustive:
// the browser gives us no way to detect a refused frame, so we warn up front for these.
const BLOCKERS = [
  'duckduckgo.com',
  'google.com',
  'bing.com',
  'github.com',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'reddit.com',
  'news.ycombinator.com',
  'developer.mozilla.org',
  'stackoverflow.com',
  'amazon.com',
  'chatgpt.com',
  'claude.ai',
];

export function knownToBlock(url: string): boolean {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) return !u.pathname.startsWith('/embed/');
    return BLOCKERS.some((b) => u.hostname === b || u.hostname.endsWith('.' + b));
  } catch {
    return false;
  }
}
