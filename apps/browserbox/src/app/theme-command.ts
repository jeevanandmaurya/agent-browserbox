import type { AgentCommand } from '@jeevanand/agent-browserbox';
import { GRAPHITE_LIGHT, resolveTheme, THEMES } from '@/ui/themes';
import { WALL_STYLES } from '@/ui/wallart';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', reset: '\x1b[0m' };
const WALLPAPER_KEY = 'desktop.wallpaper';

/** `theme`: the look of BrowserBox (Settings → Appearance), by typing. */
export const themeCommand: AgentCommand = {
  name: 'theme',
  section: 'you',
  summary: 'the theme and wallpaper: list, set, wallpaper',
  usage: `theme                       the current theme and wallpaper
theme list                  every theme
theme set <name>            graphite, midnight, forest, ember, frost, petal, ink, paper, dune, or system
theme wallpaper [style]     list the styles, or use one (theme = the theme's own)`,
  async run({ os, args, out }) {
    const [verb = '', name] = args;
    const setting = os.settings.get<string>('ui.theme', 'system');
    const current = resolveTheme(setting, true);
    const wall = os.settings.get<string>(WALLPAPER_KEY, 'theme');
    if (!verb) {
      out(`theme      ${C.bold}${setting === 'system' ? 'system (Graphite, light or dark as the device is)' : current.name}${C.reset} ${C.dim}${current.mood}${C.reset}\n`);
      out(`wallpaper  ${wall.startsWith('file:') ? wall.slice(5) : wall === 'theme' ? `the theme's own (${current.wallpapers[0]})` : wall}\n`);
      return;
    }
    if (verb === 'list') {
      for (const t of [...THEMES, GRAPHITE_LIGHT]) out(`${t.id === current.id && setting !== 'system' ? `${C.green}*${C.reset}` : ' '} ${C.bold}${t.id.padEnd(15)}${C.reset} ${(t.dark ? 'dark' : 'light').padEnd(6)} ${C.dim}${t.mood}${C.reset}\n`);
      out(`  ${C.bold}${'system'.padEnd(15)}${C.reset} ${'auto'.padEnd(6)} ${C.dim}Graphite, light or dark as the device is${C.reset}\n`);
      return;
    }
    if (verb === 'set') {
      const id = name?.toLowerCase();
      const valid = id === 'system' || id === 'light' || id === 'dark' || id === GRAPHITE_LIGHT.id || THEMES.some((t) => t.id === id);
      if (!id || !valid) throw new Error(`which theme? ${[...THEMES.map((t) => t.id), 'system'].join(', ')}`);
      os.settings.set('ui.theme', id === GRAPHITE_LIGHT.id ? 'light' : id);
      out(`theme: ${id}\n`);
      return;
    }
    if (verb === 'wallpaper') {
      if (!name) {
        for (const s of WALL_STYLES) out(`${s.id === wall ? `${C.green}*${C.reset}` : ' '} ${s.id.padEnd(10)} ${C.dim}${s.name}${C.reset}\n`);
        out(`${wall === 'theme' ? `${C.green}*${C.reset}` : ' '} ${'theme'.padEnd(10)} ${C.dim}the theme's own${C.reset}\n`);
        return;
      }
      if (name !== 'theme' && !WALL_STYLES.some((s) => s.id === name)) throw new Error(`no wallpaper ${name}: ${['theme', ...WALL_STYLES.map((s) => s.id)].join(', ')} (a picture: Settings → Appearance)`);
      os.settings.set(WALLPAPER_KEY, name);
      out(`wallpaper: ${name}\n`);
      return;
    }
    throw new Error(`unknown: theme ${verb} (help theme)`);
  },
};
