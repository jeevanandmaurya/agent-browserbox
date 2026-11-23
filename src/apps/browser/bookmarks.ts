import type { Kernel } from '@/client/index';

export interface Bookmark {
  title: string;
  url: string;
}

const KEY = 'browser.bookmarks';

// All of these allowed framing when chosen; Wikipedia also works in Reader (via its REST API).
const SEED: Bookmark[] = [
  { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page' },
  { title: 'Example Domain', url: 'https://example.com/' },
  { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/export/embed.html?bbox=-0.16%2C51.49%2C-0.07%2C51.53&layer=mapnik' },
  { title: 'Project Gutenberg', url: 'https://www.gutenberg.org/' },
];

export function isBookmarkKey(key: string): boolean {
  return key === KEY;
}

export function loadBookmarks(os: Kernel): Bookmark[] {
  const list = os.settings.get<unknown>(KEY, null);
  if (!Array.isArray(list)) return SEED.slice();
  return list.filter((b): b is Bookmark => !!b && typeof b === 'object' && typeof (b as Bookmark).url === 'string' && typeof (b as Bookmark).title === 'string');
}

export function saveBookmarks(os: Kernel, list: Bookmark[]): void {
  os.settings.set(KEY, list);
}

export function toggleBookmark(os: Kernel, url: string, title: string): boolean {
  const list = loadBookmarks(os);
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) list.splice(i, 1);
  else list.push({ title: title.slice(0, 80) || url, url });
  saveBookmarks(os, list);
  return i < 0;
}
