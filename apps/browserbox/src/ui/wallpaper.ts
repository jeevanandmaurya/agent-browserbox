import type { Kernel } from '@jeevanand/agent-browserbox-runtime/client';
import { basename, extname } from '@jeevanand/agent-browserbox-runtime/client';
import { h } from './dom';
import { icon } from './icons';
import { resolveTheme, type Theme } from './themes';
import { drawWallpaper, WALL_STYLES } from './wallart';

/**
 * Settings key: 'theme' (the theme's own wallpaper, the default), a style id
 * (drawn in the theme's colours), or `file:<path>` for a picture.
 */
export const WALLPAPER_KEY = 'desktop.wallpaper';
export const WALLPAPER_DIR = '/home/user/Pictures/Wallpapers';
export const DEFAULT_WALLPAPER = 'theme';

const IMAGE = /^(png|jpe?g|webp|avif|gif)$/;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme in use now. */
export const currentTheme = (os: Kernel): Theme => resolveTheme(os.settings.get<string>('ui.theme', 'system'), dark());

/** The style a setting draws (a picture, or a value from before themes, means the theme's own). */
function styleFor(value: string, theme: Theme): string {
  return WALL_STYLES.some((s) => s.id === value) ? value : theme.wallpapers[0]!;
}

/** Paints the chosen wallpaper on `el` and keeps it current. Returns a stop function. */
export function applyWallpaper(os: Kernel, el: HTMLElement): () => void {
  let url: string | null = null;
  let gen = 0;
  let drawnFor = '';
  const set = (next: string | null, css: string, light: boolean) => {
    if (url && url !== next) URL.revokeObjectURL(url);
    url = next;
    el.style.background = css;
    el.dataset.light = String(light);
  };
  const paint = async (force = false) => {
    const g = ++gen;
    const value = os.settings.get<string>(WALLPAPER_KEY, DEFAULT_WALLPAPER);
    const theme = currentTheme(os);
    if (value.startsWith('file:')) {
      try {
        const bytes = await os.fs.readFile(value.slice(5));
        if (g !== gen) return;
        const next = URL.createObjectURL(new Blob([bytes as BlobPart]));
        drawnFor = value;
        return set(next, `url("${next}") center / cover no-repeat, ${theme.palette.wall}`, false);
      } catch {
        /* the picture was moved or deleted: draw the theme's own */
      }
    }
    // Drawn at the screen's real size (up to 4K wide), once per theme, style and size.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(3840, Math.round((el.clientWidth || innerWidth) * ratio));
    const hgt = Math.min(2400, Math.round((el.clientHeight || innerHeight) * ratio));
    const style = styleFor(value, theme);
    const key = `${style}:${theme.id}:${w}x${hgt}`;
    if (!force && key === drawnFor) return;
    // Let the page paint first: drawing takes a moment on a slow device.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    if (g !== gen) return;
    const canvas = drawWallpaper(style, theme, w, hgt);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (g !== gen || !blob) return;
    drawnFor = key;
    const next = URL.createObjectURL(blob);
    set(next, `url("${next}") center / cover no-repeat, ${theme.palette.wall}`, !theme.dark);
  };
  void paint();
  const off = os.bus.on('settings:change', ({ key }) => (key === WALLPAPER_KEY || key === 'ui.theme') && void paint());
  const media = matchMedia('(prefers-color-scheme: dark)');
  const onMedia = () => void paint();
  media.addEventListener('change', onMedia);
  // Redrawn when the screen grows a lot (a window maximised, a monitor change).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void paint(), 400);
  };
  addEventListener('resize', onResize);
  return () => {
    off?.();
    media.removeEventListener('change', onMedia);
    removeEventListener('resize', onResize);
    if (url) URL.revokeObjectURL(url);
  };
}

/** A small picture of a wallpaper style in a theme, for pickers. */
export function wallpaperThumb(style: string, theme: Theme, w = 192, h = 120): string {
  return drawWallpaper(style, theme, w * 2, h * 2).toDataURL('image/png');
}

/** The theme's own wallpaper, every style in the theme's colours, and "Choose a picture…", for Settings → Appearance. */
export function wallpaperPicker(os: Kernel, on: Kernel['bus']['on'] = os.bus.on.bind(os.bus)): HTMLElement {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const current = () => os.settings.get<string>(WALLPAPER_KEY, DEFAULT_WALLPAPER);
  const grid = h('div', { class: 'wp-grid', role: 'group', 'aria-label': 'Wallpaper' });
  const note = h('p', { class: 'muted wp-note' });
  const custom = h('button', { class: 'wp-swatch wp-custom', type: 'button', title: 'Choose a picture…', 'aria-label': 'Choose a picture for the wallpaper', onclick: () => input.click() }, icon('plus', 18));
  let drawnFor = '';
  const render = () => {
    const theme = currentTheme(os);
    if (drawnFor !== theme.id) {
      drawnFor = theme.id;
      const swatch = (id: string, label: string, style: string) =>
        h('button', { class: 'wp-swatch', type: 'button', title: label, 'aria-label': label, dataset: { id }, style: `background:url("${wallpaperThumb(style, theme)}") center / cover`, onclick: () => os.settings.set(WALLPAPER_KEY, id) }, h('span', { class: 'wp-label' }, label));
      grid.replaceChildren(
        swatch('theme', `${theme.name}’s own`, theme.wallpapers[0]!),
        ...WALL_STYLES.map((s) => swatch(s.id, s.name, s.id)),
        custom,
      );
    }
    const v = current();
    const chosen = v.startsWith('file:') ? '' : WALL_STYLES.some((s) => s.id === v) ? v : 'theme';
    for (const b of grid.querySelectorAll<HTMLElement>('.wp-swatch[data-id]')) b.setAttribute('aria-pressed', String(b.dataset.id === chosen));
    custom.setAttribute('aria-pressed', String(v.startsWith('file:')));
    note.textContent = v.startsWith('file:') ? `Picture: ${basename(v.slice(5))}` : `Drawn in ${theme.name}’s colours; it changes with the theme. Shown on the desktop and the phone home screen.`;
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
  on('settings:change', ({ key }) => (key === WALLPAPER_KEY || key === 'ui.theme') && render());
  render();
  return h('div', { class: 'wp-picker' }, grid, note, input);
}
