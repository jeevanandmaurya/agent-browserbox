import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * What a previewed app keeps in localStorage. Its frame has no storage of its
 * own (an opaque origin, so it cannot reach BrowserBox's), so BrowserBox keeps
 * each app's in a file of the profile, one per app: a site's folder, a dev
 * server's project, an artifact. The agent can read it there when it debugs.
 */
export const PREVIEW_STORAGE_DIR = '/home/user/.local/share/browserbox/preview-storage';

export interface PreviewStore {
  load(): Promise<Record<string, string>>;
  save(data: Record<string, string>): void;
}

/** At most this much per app, as a browser would allow. */
const LIMIT = 5 * 1024 * 1024;

const fileOf = (key: string) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const name = key.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60);
  return `${PREVIEW_STORAGE_DIR}/${name}-${(h >>> 0).toString(16)}.json`;
};

export function previewStore(os: Pick<Kernel, 'fs'>, key: string): PreviewStore {
  const file = fileOf(key);
  let writing = Promise.resolve();
  return {
    async load() {
      try {
        const v = JSON.parse(await os.fs.readText(file)) as { key?: string; local?: Record<string, string> };
        return v && typeof v.local === 'object' && v.local ? v.local : {};
      } catch {
        return {};
      }
    },
    save(local) {
      const text = JSON.stringify({ key, saved: Date.now(), local }, null, 1);
      if (text.length > LIMIT) return;
      // In order, so a quick run of changes ends with the last one.
      writing = writing.then(() => os.fs.writeFile(file, text)).catch(() => undefined);
    },
  };
}
