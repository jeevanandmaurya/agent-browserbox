/**
 * System notifications for things that need you while BrowserBox is out of
 * sight: an approval or a question waiting, a chat finished. Only when you
 * allowed notifications (Settings → Permissions) and this window is hidden.
 * Clicking one brings this window forward and opens the chat.
 */
export interface Attention {
  title: string;
  body?: string;
  /** Same tag, same notification: windows of the profile do not show it twice. */
  tag: string;
  /** The chat it is about, opened when the notification is clicked. */
  sid?: string;
  /** Keep it on screen until it is answered (approvals and questions). */
  sticky?: boolean;
}

/** Fired on window when a notification about a chat is clicked; detail is its session id. */
export const OPEN_CHAT_EVENT = 'bbx:open-chat';

/** Shows a notification when this window is hidden; returns a function that takes it away. */
export function notifyAway(a: Attention): () => void {
  const N = globalThis.Notification;
  if (!N || N.permission !== 'granted' || !document.hidden) return () => undefined;
  let n: Notification;
  try {
    n = new N(a.title, { body: a.body?.slice(0, 240), tag: a.tag, requireInteraction: a.sticky ?? false, icon: `${import.meta.env.BASE_URL}icon.svg` });
  } catch {
    return () => undefined; // some browsers allow notifications only from a service worker
  }
  n.onclick = () => {
    window.focus();
    if (a.sid) window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail: a.sid }));
    n.close();
  };
  return () => n.close();
}
