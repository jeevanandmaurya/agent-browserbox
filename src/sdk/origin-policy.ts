/**
 * Which embedding pages the runtime serves.
 *
 * The runtime runs in a frame, so its storage belongs to the embedding site:
 * browsers partition third-party storage. A cross-site embedder gets its own
 * empty sandbox and can never see the files or keys of someone who uses
 * BrowserBox directly. A same-site embedder would share them, so it must be
 * listed in VITE_ALLOWED_ORIGINS. Loopback is allowed for local development.
 *
 * Sites are worked out with a short list of public suffixes. Anything not
 * recognised looks same-site, which can only refuse, never expose.
 */
const MULTI = /\.(github\.io|gitlab\.io|vercel\.app|netlify\.app|pages\.dev|web\.app|firebaseapp\.com|workers\.dev|onrender\.com|fly\.dev|herokuapp\.com|glitch\.me|stackblitz\.io|webcontainer\.io|codesandbox\.io|csb\.app|ngrok-free\.app|co\.uk|com\.au|co\.in|co\.jp)$/;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** The registrable part of a host name ("site"), approximately. */
export function siteOf(host: string): string {
  return host.split('.').slice(MULTI.test(host) ? -3 : -2).join('.');
}

export function mayConnect(origin: string, self: string, allowList: readonly string[]): boolean {
  if (origin === self || allowList.includes(origin)) return true;
  let from: URL;
  let me: URL;
  try {
    from = new URL(origin);
    me = new URL(self);
  } catch {
    return false;
  }
  // Pages on this computer (development): a different site from a hosted runtime, and the user's own when both are local.
  if (LOOPBACK.test(from.hostname)) return true;
  return from.protocol === 'https:' && siteOf(from.hostname) !== siteOf(me.hostname);
}
