/**
 * Frames inside a cross-origin isolated page (Settings → Environment) must be
 * isolated too, or they do not load. Sandboxes, previews and web pages we
 * embed are not, so they are marked credentialless (no cookies or storage of
 * their own), which lets an isolated page embed them.
 * Call before setting src; pass the URL when it is known.
 */
export function embeddable<T extends HTMLIFrameElement>(frame: T, _url?: string): T {
  if (globalThis.crossOriginIsolated) frame.setAttribute('credentialless', '');
  return frame;
}
