import { describe, expect, it } from 'vitest';
import { GRAPHITE_LIGHT, resolveTheme, THEMES, themeVars } from '../apps/browserbox/src/ui/themes';

describe('themes', () => {
  it('resolves the setting: a theme id, system, and the older dark and light', () => {
    expect(resolveTheme('midnight', true).id).toBe('midnight');
    expect(resolveTheme('paper', true).dark).toBe(false);
    expect(resolveTheme('system', true).id).toBe('graphite');
    expect(resolveTheme('system', false)).toBe(GRAPHITE_LIGHT);
    expect(resolveTheme('dark', false).id).toBe('graphite');
    expect(resolveTheme('light', true)).toBe(GRAPHITE_LIGHT);
    expect(resolveTheme('no-such-theme', true).id).toBe('graphite');
  });

  it('gives every theme a complete palette, wallpapers, and the CSS variables the app uses', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const t of [...THEMES, GRAPHITE_LIGHT]) {
      for (const [k, v] of Object.entries(t.palette)) expect(v, `${t.id}.${k}`).toMatch(hex);
      expect(t.wallpapers.length).toBeGreaterThan(0);
      const vars = themeVars(t);
      for (const name of ['--bg', '--panel', '--text', '--accent', '--accent-text', '--wall', '--ansi-blue']) expect(vars).toContain(`${name}:`);
    }
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it('keeps text readable on each theme (contrast of text and accent text)', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const t of [...THEMES, GRAPHITE_LIGHT]) {
      const p = t.palette;
      expect(ratio(p.text, p.bg), `${t.id} text`).toBeGreaterThan(7);
      expect(ratio(p.muted, p.bg), `${t.id} muted`).toBeGreaterThan(3.8);
      expect(ratio(p.accentText, p.accent), `${t.id} accent`).toBeGreaterThan(4.5);
    }
  });
});
