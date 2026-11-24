/**
 * Themes: one choice colours everything together (the agent window, the
 * desktop, terminal colours and the wallpaper), as a set rather than an accent
 * on a fixed grey. `ui.theme` holds a theme id, or 'system' (Graphite, light
 * or dark as the device prefers). The older 'dark' and 'light' values are the
 * two Graphite variants.
 */
export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  ok: string;
  warn: string;
  err: string;
  blue: string;
  magenta: string;
  cyan: string;
  /** Behind everything (the desktop before its wallpaper paints). */
  wall: string;
}

export interface Theme {
  id: string;
  name: string;
  /** A word or two about its mood, for the picker. */
  mood: string;
  dark: boolean;
  palette: Palette;
  /** Wallpaper styles made for it, the first is its own. */
  wallpapers: string[];
}

export const THEMES: Theme[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    mood: 'Warm grey, teal',
    dark: true,
    palette: { bg: '#131312', panel: '#1a1a19', panel2: '#232321', panel3: '#2d2d2a', border: '#31312e', text: '#eceae4', muted: '#9c9a92', accent: '#4fb89c', accentText: '#0f1a17', ok: '#56b886', warn: '#d6a54a', err: '#e5786d', blue: '#6ea8fe', magenta: '#c49cf5', cyan: '#5ccfe6', wall: '#131312' },
    wallpapers: ['ridges', 'contours', 'stars'],
  },
  {
    id: 'midnight',
    name: 'Midnight',
    mood: 'Neon city at night',
    dark: true,
    palette: { bg: '#0e0f1d', panel: '#14162a', panel2: '#1b1e36', panel3: '#242845', border: '#2a2f50', text: '#dde2ff', muted: '#8b91bb', accent: '#8ea8ff', accentText: '#0c0e1c', ok: '#8fd9a0', warn: '#f0bd76', err: '#ff7a93', blue: '#7aa2f7', magenta: '#c7a4ff', cyan: '#79dbe8', wall: '#0a0b16' },
    wallpapers: ['skyline', 'stars', 'ridges'],
  },
  {
    id: 'forest',
    name: 'Forest',
    mood: 'Moss, sage and cream',
    dark: true,
    palette: { bg: '#1b211d', panel: '#212923', panel2: '#29322b', panel3: '#323c34', border: '#38443b', text: '#e6e0c8', muted: '#9ea692', accent: '#a9c47f', accentText: '#18200f', ok: '#9fc98a', warn: '#e0bf79', err: '#e5807a', blue: '#7fb5ad', magenta: '#d39cb8', cyan: '#86c69a', wall: '#161b17' },
    wallpapers: ['ridges', 'contours', 'dunes'],
  },
  {
    id: 'ember',
    name: 'Ember',
    mood: 'Retro warmth, amber',
    dark: true,
    palette: { bg: '#1d1916', panel: '#25201c', panel2: '#2e2823', panel3: '#39312a', border: '#41372f', text: '#f0e3cd', muted: '#a99a89', accent: '#f2a04a', accentText: '#1f1307', ok: '#b8bf6a', warn: '#f2c674', err: '#ea6f5b', blue: '#86a8b9', magenta: '#cc9bb6', cyan: '#8fc7a9', wall: '#181411' },
    wallpapers: ['sun', 'dunes', 'bauhaus'],
  },
  {
    id: 'frost',
    name: 'Frost',
    mood: 'Arctic blue, quiet',
    dark: true,
    palette: { bg: '#1a1f28', panel: '#202632', panel2: '#272e3c', panel3: '#303949', border: '#354051', text: '#e3e9f3', muted: '#96a1b4', accent: '#89c2d4', accentText: '#0f171d', ok: '#9cc59b', warn: '#e6c27e', err: '#e48a8a', blue: '#84a3c6', magenta: '#b89acb', cyan: '#8fd1da', wall: '#151a22' },
    wallpapers: ['contours', 'ridges', 'stars'],
  },
  {
    id: 'petal',
    name: 'Petal',
    mood: 'Dusk rose and plum',
    dark: true,
    palette: { bg: '#1c1722', panel: '#231d2a', panel2: '#2b2433', panel3: '#352d3f', border: '#3c3346', text: '#eee3f0', muted: '#a597ad', accent: '#ee9fb6', accentText: '#251019', ok: '#9fd0b3', warn: '#f3c58f', err: '#f08192', blue: '#9fb7ea', magenta: '#d8a7ea', cyan: '#96d3da', wall: '#17121c' },
    wallpapers: ['sun', 'ridges', 'stars'],
  },
  {
    id: 'ink',
    name: 'Ink',
    mood: 'Matte black, amber',
    dark: true,
    palette: { bg: '#0c0c0c', panel: '#131313', panel2: '#1a1a1a', panel3: '#232323', border: '#292929', text: '#e9e7e2', muted: '#8d8b86', accent: '#e9b24c', accentText: '#140e03', ok: '#8cc68c', warn: '#e9b24c', err: '#e06d63', blue: '#8ba9d9', magenta: '#c59bd2', cyan: '#85cac5', wall: '#080808' },
    wallpapers: ['contours', 'bauhaus', 'skyline'],
  },
  {
    id: 'paper',
    name: 'Paper',
    mood: 'Light, ink blue',
    dark: false,
    palette: { bg: '#f4f1ea', panel: '#fbf9f4', panel2: '#efebe2', panel3: '#e6e1d6', border: '#ddd7ca', text: '#24221d', muted: '#6e695e', accent: '#2f5fa6', accentText: '#ffffff', ok: '#2f7d4f', warn: '#93660a', err: '#b8433a', blue: '#2f5fa6', magenta: '#7d3fa6', cyan: '#127482', wall: '#ece7dc' },
    wallpapers: ['bauhaus', 'contours', 'sun'],
  },
  {
    id: 'dune',
    name: 'Dune',
    mood: 'Light, sand and terracotta',
    dark: false,
    palette: { bg: '#f2e8da', panel: '#faf3e8', panel2: '#ece0cf', panel3: '#e3d4bf', border: '#dccbb3', text: '#2a2118', muted: '#77695a', accent: '#b8522b', accentText: '#ffffff', ok: '#4f7a3a', warn: '#9a6b12', err: '#b23a2e', blue: '#3a6a8e', magenta: '#8e4a78', cyan: '#2e7a74', wall: '#eadcc8' },
    wallpapers: ['dunes', 'sun', 'ridges'],
  },
];

/** Graphite's light variant (the 'light' setting, and 'system' on a light device). */
export const GRAPHITE_LIGHT: Theme = {
  id: 'graphite-light',
  name: 'Graphite light',
  mood: 'Warm paper, teal',
  dark: false,
  palette: { bg: '#f1f0eb', panel: '#f9f8f4', panel2: '#efeee8', panel3: '#e5e3dc', border: '#e0ded6', text: '#22211e', muted: '#6f6d66', accent: '#1f7f69', accentText: '#ffffff', ok: '#1f7f4d', warn: '#946200', err: '#c2463b', blue: '#1f5fbf', magenta: '#7a3fb8', cyan: '#0e6e80', wall: '#f1f0eb' },
  wallpapers: ['contours', 'bauhaus', 'dunes'],
};

/** The theme a setting means, on a device that prefers dark or light. */
export function resolveTheme(setting: unknown, systemDark: boolean): Theme {
  const graphite = THEMES[0]!;
  if (setting === 'light') return GRAPHITE_LIGHT;
  if (setting === 'system' || setting === undefined) return systemDark ? graphite : GRAPHITE_LIGHT;
  return THEMES.find((t) => t.id === setting) ?? (setting === GRAPHITE_LIGHT.id ? GRAPHITE_LIGHT : graphite);
}

/** CSS custom properties for a theme (the names base.css uses). */
export function themeVars(t: Theme): string {
  const p = t.palette;
  const shadow = t.dark ? '0 12px 40px rgb(0 0 0 / 0.5)' : '0 12px 40px rgb(30 28 20 / 0.14)';
  return [
    ['--bg', p.bg], ['--panel', p.panel], ['--panel-2', p.panel2], ['--panel-3', p.panel3], ['--border', p.border],
    ['--text', p.text], ['--muted', p.muted], ['--accent', p.accent], ['--accent-text', p.accentText],
    ['--ok', p.ok], ['--warn', p.warn], ['--err', p.err], ['--ansi-blue', p.blue], ['--ansi-magenta', p.magenta], ['--ansi-cyan', p.cyan],
    ['--wall', p.wall], ['--raised', t.dark ? p.panel2 : '#ffffff'], ['--shadow', shadow],
  ].map(([k, v]) => `${k}:${v}`).join(';');
}
