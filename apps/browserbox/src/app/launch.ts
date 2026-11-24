/**
 * What the installed app was launched with: files opened from the computer
 * ("Open with BrowserBox", the manifest's file_handlers, via launchQueue), or
 * things shared to it from another app (share_target, parked by the service
 * worker). Each arrives as files and text for the message box.
 */
export interface Incoming {
  files: File[];
  text: string;
}

const SHARE = 'bbx-share';

/** Calls `fn` for files the app is launched with, now and on later launches into this window. */
export function onLaunchFiles(fn: (i: Incoming) => void): void {
  const q = (globalThis as { launchQueue?: { setConsumer(c: (p: { files?: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  q?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    fn({ files, text: '' });
  });
}

/** Takes what was shared to the app (`?shared=<id>` from the service worker), once. */
export async function takeShared(): Promise<Incoming | null> {
  const id = new URLSearchParams(location.search).get('shared');
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  history.replaceState(null, '', location.pathname);
  const cache = await caches.open(SHARE);
  const key = `https://share.browserbox.local/${id}`;
  const metaRes = await cache.match(key);
  if (!metaRes) return null;
  const meta = (await metaRes.json()) as { title: string; text: string; url: string; files: Array<{ key: string; name: string; type: string }> };
  const files: File[] = [];
  for (const f of meta.files) {
    const r = await cache.match(f.key);
    if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
    await cache.delete(f.key);
  }
  await cache.delete(key);
  const text = [meta.title, meta.text, meta.url].filter((x) => x && x.trim()).filter((x, i, a) => a.indexOf(x) === i).join('\n');
  return { files, text };
}
