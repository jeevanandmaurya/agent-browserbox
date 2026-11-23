import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { basename, extname } from '@jeevanand/agent-browserbox-runtime/client';
import { h } from './dom';
import { icon } from './icons';

/** Settings key: a preset id, or `file:<path>` for a picture from the filesystem. */
export const WALLPAPER_KEY = 'desktop.wallpaper';
export const WALLPAPER_DIR = '/home/user/Pictures/Wallpapers';

export interface Wallpaper {
  id: string;
  name: string;
  /** A CSS `background` value: drawn by the browser, so nothing to download. */
  css: string;
  /** Light pictures get dark icon labels. */
  light?: boolean;
}

export const WALLPAPERS: Wallpaper[] = [
  { id: 'dusk', name: 'Dusk', css: 'radial-gradient(120% 90% at 85% 8%, #1f5c50 0%, transparent 55%), radial-gradient(90% 80% at 0% 100%, #3a2b4a 0%, transparent 60%), #151514' },
  { id: 'tide', name: 'Tide', css: 'linear-gradient(165deg, #0f2027 0%, #1d3a44 48%, #2b5262 100%)' },
  { id: 'ember', name: 'Ember', css: 'radial-gradient(100% 80% at 18% 0%, #7a3b1d 0%, transparent 60%), radial-gradient(80% 70% at 100% 100%, #5a1e2e 0%, transparent 62%), #1a1312' },
  { id: 'meadow', name: 'Meadow', css: 'radial-gradient(110% 90% at 100% 0%, #3f6b3a 0%, transparent 58%), radial-gradient(100% 90% at 0% 100%, #1f4a49 0%, transparent 60%), #121714' },
  { id: 'sand', name: 'Sand', css: 'radial-gradient(120% 90% at 90% 0%, #f6efe2 0%, transparent 60%), linear-gradient(170deg, #ece2cf 0%, #d6c4a2 100%)', light: true },
  { id: 'mist', name: 'Mist', css: 'radial-gradient(130% 100% at 50% 0%, #eef3f2 0%, #c7d6d4 100%)', light: true },
  { id: 'graphite', name: 'Graphite', css: '#1c1c1b' },
  { id: 'grid', name: 'Grid', css: 'linear-gradient(rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, rgb(255 255 255 / 0.045) 1px, transparent 1px) 0 0 / 28px 28px, #161615' },
];
export const DEFAULT_WALLPAPER = 'dusk';

const IMAGE = /^(png|jpe?g|webp|avif|gif)$/;

/** Paints the chosen wallpaper on `el` and keeps it current. Returns a stop function. */
export function applyWallpaper(os: Kernel, el: HTMLElement): () => void {
  let url: string | null = null;
  let gen = 0;
  const paint = async () => {
    const g = ++gen;
    const value = os.settings.get<string>(WALLPAPER_KEY, DEFAULT_WALLPAPER);
    let css = (WALLPAPERS.find((w) => w.id === value) ?? WALLPAPERS[0]!).css;
    let light = WALLPAPERS.find((w) => w.id === value)?.light ?? false;
    if (value.startsWith('file:')) {
      try {
        const bytes = await os.fs.readFile(value.slice(5));
        if (g !== gen) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        css = `url("${url}") center / cover no-repeat, #151514`;
        light = false;
      } catch {
        /* the picture was moved or deleted: keep the default */
      }
    }
    if (g !== gen) return;
    el.style.background = css;
    el.dataset.light = String(light);
  };
  void paint();
  const off = os.bus.on('settings:change', ({ key }) => key === WALLPAPER_KEY && void paint());
  return () => {
    off?.();
    if (url) URL.revokeObjectURL(url);
  };
}

/** Swatches plus "Choose a picture…", for Settings → Appearance. */
export function wallpaperPicker(os: Kernel, on: Kernel['bus']['on'] = os.bus.on.bind(os.bus)): HTMLElement {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const current = () => os.settings.get<string>(WALLPAPER_KEY, DEFAULT_WALLPAPER);
  const swatch = (id: string, label: string, css: string) =>
    h('button', { class: 'wp-swatch', type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(current() === id), dataset: { id }, style: `background:${css}`, onclick: () => os.settings.set(WALLPAPER_KEY, id) });
  const custom = h('button', { class: 'wp-swatch wp-custom', type: 'button', title: 'Choose a picture…', 'aria-label': 'Choose a picture for the wallpaper', onclick: () => input.click() }, icon('plus', 18));
  const grid = h('div', { class: 'wp-grid', role: 'group', 'aria-label': 'Wallpaper' }, WALLPAPERS.map((w) => swatch(w.id, w.name, w.css)), custom);
  const note = h('p', { class: 'muted wp-note' });
  const refresh = () => {
    const v = current();
    for (const b of grid.querySelectorAll<HTMLElement>('.wp-swatch[data-id]')) b.setAttribute('aria-pressed', String(b.dataset.id === v));
    custom.setAttribute('aria-pressed', String(v.startsWith('file:')));
    note.textContent = v.startsWith('file:') ? `Picture: ${basename(v.slice(5))}` : 'Shown on the desktop and the phone home screen.';
  };
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const ext = extname(file.name) || 'png';
    if (!IMAGE.test(ext)) return os.notify({ title: 'Choose a PNG, JPEG, WebP, AVIF or GIF picture', level: 'warn' });
    const path = `${WALLPAPER_DIR}/${file.name.replace(/[^\w.-]+/g, '_')}`;
    await os.fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
    os.settings.set(WALLPAPER_KEY, `file:${path}`);
    input.value = '';
  });
  on('settings:change', ({ key }) => key === WALLPAPER_KEY && refresh());
  refresh();
  return h('div', { class: 'wp-picker' }, grid, note, input);
}
