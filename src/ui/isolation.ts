/** Hosts whose pages are built to be embedded in isolated pages (they need their own service worker). */
const ISOLATED_HOSTS = /(^|\.)webcontainer-api\.io$|(^|\.)webcontainer\.io$/;

/**
 * Frames inside a cross-origin isolated page (Settings → Environment) must be
 * isolated too, or they do not load. Sandboxes, previews and web pages we
 * embed are not, so they are marked credentialless (no cookies or storage of
 * their own), which lets an isolated page embed them. Pages that are isolated
 * themselves (Node.js dev servers in WebContainers) are left as they are.
 * Call before setting src; pass the URL when it is known.
 */
export function embeddable<T extends HTMLIFrameElement>(frame: T, url?: string): T {
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch {
    /* not a URL */
  }
  if (globalThis.crossOriginIsolated && !ISOLATED_HOSTS.test(host)) frame.setAttribute('credentialless', '');
  return frame;
}
