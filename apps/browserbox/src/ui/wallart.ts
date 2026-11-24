import type { Palette, Theme } from './themes';

/**
 * Wallpapers drawn in the browser from the theme's colours: nothing to
 * download, sharp at any size, and they change colour with the theme. Each
 * style is seeded, so a wallpaper looks the same every time it is drawn.
 */
export interface WallStyle {
  id: string;
  name: string;
  draw(c: CanvasRenderingContext2D, w: number, h: number, t: Theme, rnd: () => number): void;
}

// ---- small helpers ------------------------------------------------------------------

/** A seeded random number generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261);
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** `a` mixed with `b` (t = 0 → a, 1 → b), as a hex colour. */
function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const alpha = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgb(${r} ${g} ${b} / ${a})`;
};

/** Smooth 2D value noise in [0, 1], with a few octaves. */
function noise(rnd: () => number): (x: number, y: number) => number {
  const size = 256;
  const grid = Float32Array.from({ length: size * size }, () => rnd());
  const at = (x: number, y: number) => grid[((y & (size - 1)) * size + (x & (size - 1)))]!;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const one = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * fx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x, y) => {
    let v = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < 4; o++, amp /= 2, f *= 2) v += one(x * f, y * f) * amp;
    return v / 0.9375;
  };
}

function vertical(c: CanvasRenderingContext2D, h: number, stops: Array<[number, string]>): CanvasGradient {
  const g = c.createLinearGradient(0, 0, 0, h);
  for (const [at, col] of stops) g.addColorStop(at, col);
  return g;
}

function glow(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, a: number): void {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(col, a));
  g.addColorStop(1, alpha(col, 0));
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

function starfield(c: CanvasRenderingContext2D, w: number, h: number, p: Palette, rnd: () => number, count: number, top: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() ** 1.6 * h * top;
    const r = rnd() < 0.04 ? 1.6 : rnd() * 0.9 + 0.3;
    c.fillStyle = alpha(mix(p.text, p.cyan, rnd() * 0.4), 0.25 + rnd() * 0.6);
    c.beginPath();
    c.arc(x, y, r * (w / 1600), 0, Math.PI * 2);
    c.fill();
  }
}

/** Fine grain over everything, so large flat areas do not band. */
function grain(c: CanvasRenderingContext2D, w: number, h: number, rnd: () => number, dark: boolean): void {
  const tile = document.createElement('canvas');
  tile.width = tile.height = 128;
  const tc = tile.getContext('2d')!;
  const img = tc.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = rnd() * (dark ? 14 : 10);
  }
  tc.putImageData(img, 0, 0);
  c.fillStyle = c.createPattern(tile, 'repeat')!;
  c.fillRect(0, 0, w, h);
}

// ---- the styles ---------------------------------------------------------------------

/** Layered mountain ridges fading into haze, under a low sun or moon. */
const ridges: WallStyle = {
  id: 'ridges',
  name: 'Ridges',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    const sky = t.dark ? mix(p.wall, p.accent, 0.06) : mix(p.bg, p.accent, 0.08);
    const horizon = t.dark ? mix(p.panel3, p.accent, 0.3) : mix(p.panel, p.warn, 0.25);
    c.fillStyle = vertical(c, h, [[0, sky], [0.62, horizon], [1, horizon]]);
    c.fillRect(0, 0, w, h);
    if (t.dark) starfield(c, w, h, p, rnd, Math.round((w * h) / 9000), 0.55);
    const sx = w * (0.62 + rnd() * 0.18);
    const sy = h * (0.36 + rnd() * 0.06);
    const sr = Math.min(w, h) * 0.075;
    glow(c, sx, sy, sr * 5, p.accent, t.dark ? 0.16 : 0.22);
    c.fillStyle = mix(p.accent, p.text, t.dark ? 0.35 : 0.1);
    c.beginPath();
    c.arc(sx, sy, sr, 0, Math.PI * 2);
    c.fill();
    const n = noise(rnd);
    const layers = 5;
    for (let i = 0; i < layers; i++) {
      const k = i / (layers - 1);
      const base = h * (0.5 + k * 0.1);
      const amp = h * (0.2 - k * 0.09);
      const far = mix(horizon, p.accent, 0.12);
      const near = t.dark ? p.wall : mix(p.text, p.bg, 0.55);
      c.fillStyle = mix(far, near, 0.25 + k * 0.75);
      c.beginPath();
      c.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 160) {
        const v = n(x / w * (2.5 + k * 2) + i * 13.7, i * 3.1);
        // Sharper peaks: emphasise the high parts of the noise.
        c.lineTo(x, base - amp * Math.pow(v, 1.6) * 1.6 + amp * 0.3);
      }
      c.lineTo(w, h);
      c.closePath();
      c.fill();
      // Haze between ranges.
      c.fillStyle = vertical(c, h, [[0, alpha(horizon, 0)], [Math.min(0.99, base / h + 0.04), alpha(horizon, 0)], [1, alpha(horizon, t.dark ? 0.12 : 0.18)]]);
      c.fillRect(0, 0, w, h);
    }
  },
};

/** Topographic contour lines over a soft field, every fifth one heavier. */
const contours: WallStyle = {
  id: 'contours',
  name: 'Contours',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    const g = c.createRadialGradient(w * 0.3, h * 0.25, 0, w * 0.3, h * 0.25, Math.max(w, h));
    g.addColorStop(0, t.dark ? mix(p.panel2, p.accent, 0.08) : p.panel);
    g.addColorStop(1, p.wall);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const n = noise(rnd);
    const cols = 150;
    const cell = w / cols;
    const rows = Math.ceil(h / cell) + 1;
    const field = new Float32Array((cols + 1) * rows);
    const scale = 2.2 / cols;
    for (let y = 0; y < rows; y++) for (let x = 0; x <= cols; x++) field[y * (cols + 1) + x] = n(x * scale * 1.4 + 7, y * scale * 1.4 + 3);
    // Spread the levels over the field's real range, so the whole picture has lines.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of field) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
    for (let i = 0; i < field.length; i++) field[i] = (field[i]! - lo) / (hi - lo || 1);
    const at = (x: number, y: number) => field[y * (cols + 1) + x]!;
    const levels = 34;
    c.lineCap = 'round';
    for (let l = 1; l < levels; l++) {
      const iso = l / levels;
      const heavy = l % 5 === 0;
      c.strokeStyle = alpha(heavy ? p.accent : mix(p.accent, p.muted, 0.35), heavy ? (t.dark ? 0.6 : 0.65) : t.dark ? 0.3 : 0.38);
      c.lineWidth = (heavy ? 1.6 : 0.9) * (w / 1600) * 1.2;
      c.beginPath();
      for (let y = 0; y < rows - 1; y++) {
        for (let x = 0; x < cols; x++) {
          const a = at(x, y);
          const b = at(x + 1, y);
          const cc = at(x + 1, y + 1);
          const d = at(x, y + 1);
          const code = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (cc > iso ? 2 : 0) | (d > iso ? 1 : 0);
          if (code === 0 || code === 15) continue;
          const lerp = (v1: number, v2: number) => (iso - v1) / (v2 - v1);
          const top: [number, number] = [(x + lerp(a, b)) * cell, y * cell];
          const right: [number, number] = [(x + 1) * cell, (y + lerp(b, cc)) * cell];
          const bottom: [number, number] = [(x + lerp(d, cc)) * cell, (y + 1) * cell];
          const left: [number, number] = [x * cell, (y + lerp(a, d)) * cell];
          const seg = (p1: [number, number], p2: [number, number]) => {
            c.moveTo(p1[0], p1[1]);
            c.lineTo(p2[0], p2[1]);
          };
          switch (code) {
            case 1: case 14: seg(left, bottom); break;
            case 2: case 13: seg(bottom, right); break;
            case 3: case 12: seg(left, right); break;
            case 4: case 11: seg(top, right); break;
            case 6: case 9: seg(top, bottom); break;
            case 7: case 8: seg(left, top); break;
            case 5: seg(left, top); seg(bottom, right); break;
            case 10: seg(top, right); seg(left, bottom); break;
          }
        }
      }
      c.stroke();
    }
  },
};

/** Soft dunes in bands of light, like late afternoon. */
const dunes: WallStyle = {
  id: 'dunes',
  name: 'Dunes',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    const top = t.dark ? mix(p.wall, p.magenta, 0.08) : mix(p.panel, p.accent, 0.06);
    const low = t.dark ? mix(p.panel3, p.warn, 0.22) : mix(p.bg, p.warn, 0.3);
    c.fillStyle = vertical(c, h, [[0, top], [0.45, low], [1, low]]);
    c.fillRect(0, 0, w, h);
    glow(c, w * 0.3, h * 0.3, Math.min(w, h) * 0.5, p.warn, t.dark ? 0.12 : 0.2);
    const bands = 7;
    for (let i = 0; i < bands; i++) {
      const k = i / (bands - 1);
      // Further apart towards the viewer, like real distance.
      const base = h * (0.4 + Math.pow(k, 1.3) * 0.5);
      // Warm all the way down: far dunes pale and hazy, near ones deep.
      const far = mix(mix(p.warn, p.accent, 0.4), t.dark ? p.panel3 : p.bg, t.dark ? 0.35 : 0.45);
      const near = t.dark ? mix(p.accent, p.wall, 0.78) : mix(p.accent, p.bg, 0.3);
      const sand = mix(far, near, Math.pow(k, 1.2));
      const f1 = 1 + rnd() * 1.5;
      const f2 = 2 + rnd() * 3;
      const ph1 = rnd() * 6.28;
      const ph2 = rnd() * 6.28;
      const amp = h * (0.035 + k * 0.04 + rnd() * 0.02);
      const ys: number[] = [];
      for (let x = 0; x <= w; x += w / 200) ys.push(base + Math.sin((x / w) * Math.PI * f1 + ph1) * amp + Math.sin((x / w) * Math.PI * f2 + ph2) * amp * 0.35);
      c.fillStyle = vertical(c, h, [[Math.max(0, base / h - 0.1), mix(sand, t.dark ? p.text : '#ffffff', t.dark ? 0.1 : 0.3)], [Math.min(1, base / h + 0.18), sand], [1, mix(sand, t.dark ? p.wall : p.text, 0.15)]]);
      c.beginPath();
      c.moveTo(0, h);
      ys.forEach((y, j) => c.lineTo((j * w) / 200, y));
      c.lineTo(w, h);
      c.closePath();
      c.fill();
      // A thin lit crest.
      c.strokeStyle = alpha(p.text, t.dark ? 0.08 : 0.25);
      c.lineWidth = Math.max(1, w / 1600);
      c.beginPath();
      ys.forEach((y, j) => (j ? c.lineTo((j * w) / 200, y) : c.moveTo(0, y)));
      c.stroke();
    }
  },
};

/** A geometric poster: quarter circles, halves and squares on a grid. */
const bauhaus: WallStyle = {
  id: 'bauhaus',
  name: 'Bauhaus',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    c.fillStyle = p.wall;
    c.fillRect(0, 0, w, h);
    const tone = (col: string) => mix(col, p.wall, t.dark ? 0.5 : 0.35);
    const colours = [p.accent, p.warn, p.err, p.blue, p.cyan, p.panel3, t.dark ? p.panel2 : p.panel].map(tone);
    const cols = w > h ? 6 : 4;
    const size = w / cols;
    const rows = Math.ceil(h / size);
    const pick = () => colours[Math.floor(rnd() * colours.length)]!;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const x0 = x * size;
        const y0 = y * size;
        let bgc = pick();
        let fg = pick();
        while (fg === bgc) fg = pick();
        // Mostly calm tiles, a few loud ones.
        const quiet = t.dark ? mix(p.wall, p.panel2, 0.6) : mix(p.wall, p.panel, 0.5);
        // The left column stays quiet: the desktop's icons sit there.
        if (x === 0) {
          c.fillStyle = quiet;
          c.fillRect(x0, y0, size + 1, size + 1);
          continue;
        }
        if (rnd() < 0.62) bgc = quiet;
        c.fillStyle = bgc;
        c.fillRect(x0, y0, size + 1, size + 1);
        c.fillStyle = fg;
        const m = Math.floor(rnd() * 6);
        const corner = Math.floor(rnd() * 4);
        const cx = x0 + (corner % 2) * size;
        const cy = y0 + Math.floor(corner / 2) * size;
        // Shapes are clipped to their tile: a quarter circle from a corner, a circle,
        // a half circle on an edge, a square, stripes, or a small quarter.
        c.save();
        c.beginPath();
        c.rect(x0, y0, size, size);
        c.clip();
        c.beginPath();
        if (m === 0) c.arc(cx, cy, size, 0, Math.PI * 2);
        else if (m === 1) c.arc(x0 + size / 2, y0 + size / 2, size * 0.38, 0, Math.PI * 2);
        else if (m === 2) c.arc(x0 + size / 2, y0 + (corner < 2 ? 0 : size), size / 2, 0, Math.PI * 2);
        else if (m === 3) c.rect(x0 + size * 0.25, y0 + size * 0.25, size * 0.5, size * 0.5);
        else if (m === 4) for (let s = 0; s < 4; s++) c.rect(x0, y0 + (s * size) / 4, size, size / 8);
        else c.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
    }
  },
};

/** A retro sun cut by horizon lines, over a halftone floor. */
const sun: WallStyle = {
  id: 'sun',
  name: 'Sunset',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    const horizonY = h * 0.66;
    const sky = t.dark ? p.wall : mix(p.panel, p.accent, 0.05);
    const near = t.dark ? mix(p.panel3, p.magenta, 0.25) : mix(p.bg, p.warn, 0.35);
    c.fillStyle = vertical(c, h, [[0, sky], [horizonY / h, near], [1, t.dark ? p.wall : p.panel3]]);
    c.fillRect(0, 0, w, h);
    if (t.dark) starfield(c, w, h, p, rnd, Math.round((w * h) / 14000), 0.5);
    const r = Math.min(w, h) * 0.3;
    const cx = w * 0.5;
    const cy = horizonY - r * 0.15;
    glow(c, cx, cy, r * 2.4, p.accent, t.dark ? 0.18 : 0.22);
    c.save();
    c.beginPath();
    c.rect(0, 0, w, horizonY);
    c.clip();
    const sg = c.createLinearGradient(0, cy - r, 0, cy + r);
    sg.addColorStop(0, p.warn);
    sg.addColorStop(0.55, p.accent);
    sg.addColorStop(1, p.err);
    c.fillStyle = sg;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    // Bars cut from the lower half, thicker towards the horizon.
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0, y = cy; y < cy + r; i++) {
      const bar = 2 + i * 2.2 * (h / 1000);
      c.fillRect(cx - r, y, r * 2, bar);
      y += bar + (12 - i * 0.8) * (h / 1000);
    }
    c.restore();
    // The cut-outs show the sky behind again.
    c.globalCompositeOperation = 'destination-over';
    c.fillStyle = vertical(c, h, [[0, sky], [horizonY / h, near]]);
    c.fillRect(0, 0, w, horizonY);
    c.globalCompositeOperation = 'source-over';
    // Halftone floor: dots that grow towards the viewer.
    const step = Math.max(10, w / 90);
    for (let y = horizonY + step / 2; y < h; y += step) {
      const k = (y - horizonY) / (h - horizonY);
      for (let x = (Math.floor(y / step) % 2) * (step / 2); x < w; x += step) {
        const dr = step * 0.45 * k * (0.75 + 0.25 * Math.sin(x / w * 9 + k * 4));
        c.fillStyle = alpha(p.accent, 0.15 + k * 0.35);
        c.beginPath();
        c.arc(x, y, dr, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.fillStyle = alpha(p.accent, 0.6);
    c.fillRect(0, horizonY, w, Math.max(1, h / 700));
  },
};

/** A pixel-art city at night: two rows of buildings, lit windows, a moon. */
const skyline: WallStyle = {
  id: 'skyline',
  name: 'Skyline',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    const px = Math.max(4, Math.round(w / 300));
    const snap = (v: number) => Math.round(v / px) * px;
    c.fillStyle = vertical(c, h, [[0, t.dark ? p.wall : mix(p.panel, p.blue, 0.15)], [0.7, t.dark ? mix(p.panel3, p.magenta, 0.35) : mix(p.bg, p.warn, 0.3)], [1, t.dark ? mix(p.panel3, p.magenta, 0.35) : mix(p.bg, p.warn, 0.3)]]);
    c.fillRect(0, 0, w, h);
    // Pixel stars and moon.
    for (let i = 0; i < (w * h) / 6000; i++) {
      c.fillStyle = alpha(p.text, 0.25 + rnd() * 0.6);
      c.fillRect(snap(rnd() * w), snap(rnd() ** 1.5 * h * 0.55), px / 2 + (rnd() < 0.1 ? px / 2 : 0), px / 2 + (rnd() < 0.1 ? px / 2 : 0));
    }
    const mr = snap(Math.min(w, h) * 0.06);
    const mx = snap(w * 0.78);
    const my = snap(h * 0.22);
    glow(c, mx, my, mr * 4, p.cyan, 0.12);
    c.fillStyle = mix(p.text, p.cyan, 0.15);
    for (let y = -mr; y <= mr; y += px) for (let x = -mr; x <= mr; x += px) if (x * x + y * y <= mr * mr && (x - mr * 0.45) ** 2 + (y + mr * 0.2) ** 2 > (mr * 0.8) ** 2) c.fillRect(mx + x, my + y, px, px);
    const city = (base: number, minH: number, maxH: number, col: string, lit: number) => {
      for (let x = 0; x < w; ) {
        const bw = snap(px * (6 + rnd() * 14));
        const bh = snap(minH + rnd() * (maxH - minH));
        const top = snap(base - bh);
        c.fillStyle = col;
        c.fillRect(x, top, bw, h - top);
        // A roof detail now and then: an antenna or a step.
        if (rnd() < 0.3) c.fillRect(x + snap(bw / 2), top - px * 3, px, px * 3);
        else if (rnd() < 0.3) c.fillRect(x + px, top - px * 2, bw - px * 2, px * 2);
        for (let wy = top + px * 2; wy < h - px * 2; wy += px * 3) {
          for (let wx = x + px; wx < x + bw - px; wx += px * 2) {
            if (rnd() < lit) {
              c.fillStyle = alpha(rnd() < 0.8 ? p.warn : p.cyan, 0.55 + rnd() * 0.4);
              c.fillRect(wx, wy, px, px);
            }
          }
        }
        x += bw + (rnd() < 0.3 ? px * 2 : 0);
      }
    };
    city(h * 0.78, h * 0.12, h * 0.42, t.dark ? mix(p.panel2, p.blue, 0.18) : mix(p.panel3, p.blue, 0.2), 0.08);
    city(h * 0.95, h * 0.08, h * 0.3, t.dark ? p.wall : mix(p.text, p.bg, 0.45), 0.16);
  },
};

/** A deep starfield with a faint milky band and a little nebula colour. */
const stars: WallStyle = {
  id: 'stars',
  name: 'Starfield',
  draw(c, w, h, t, rnd) {
    const p = t.palette;
    c.fillStyle = vertical(c, h, [[0, t.dark ? p.wall : mix(p.text, p.blue, 0.3)], [1, t.dark ? mix(p.panel2, p.blue, 0.15) : mix(p.text, p.magenta, 0.25)]]);
    c.fillRect(0, 0, w, h);
    glow(c, w * 0.7, h * 0.35, Math.max(w, h) * 0.45, p.magenta, 0.1);
    glow(c, w * 0.25, h * 0.7, Math.max(w, h) * 0.4, p.blue, 0.1);
    const n = noise(rnd);
    // The galaxy's band: a diagonal from lower left to upper right, soft glows along it.
    const bandY = (x: number) => h * 0.78 - (x / w) * h * 0.62;
    const width = h * 0.13;
    const tints = [p.magenta, p.blue, p.cyan, p.accent];
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w;
      const y = bandY(x) + (rnd() - 0.5) * width * 1.6;
      glow(c, x, y, width * (0.6 + rnd() * 1.2), tints[i % tints.length]!, t.dark ? 0.05 + rnd() * 0.05 : 0.08);
    }
    const count = Math.round((w * h) / 260);
    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const d = (y - bandY(x)) / width;
      const band = Math.exp(-(d * d) / 2);
      // Few stars away from the band, many in it, in clumps.
      if (rnd() > 0.06 + band * (0.25 + n(x / w * 8, y / h * 8) * 1.1)) continue;
      const r = (rnd() ** 3 * 1.3 + 0.3) * (w / 1600);
      c.fillStyle = alpha(mix('#ffffff', rnd() < 0.5 ? p.cyan : p.warn, rnd() * 0.35), 0.3 + rnd() * 0.65);
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    // Dark lanes of dust through the band.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * w;
      glow(c, x, bandY(x) + (rnd() - 0.5) * width * 0.6, width * (0.25 + rnd() * 0.4), p.wall, 0.25);
    }
    // A few bright stars with glints.
    for (let i = 0; i < 9; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = (2 + rnd() * 2) * (w / 1600);
      glow(c, x, y, r * 8, p.text, 0.25);
      c.strokeStyle = alpha(p.text, 0.5);
      c.lineWidth = Math.max(1, w / 2400);
      c.beginPath();
      c.moveTo(x - r * 6, y);
      c.lineTo(x + r * 6, y);
      c.moveTo(x, y - r * 6);
      c.lineTo(x, y + r * 6);
      c.stroke();
    }
  },
};

export const WALL_STYLES: WallStyle[] = [ridges, contours, dunes, bauhaus, sun, skyline, stars];

/** Draws a wallpaper style in a theme's colours onto a new canvas of this size. */
export function drawWallpaper(styleId: string, theme: Theme, w: number, h: number): HTMLCanvasElement {
  const style = WALL_STYLES.find((s) => s.id === styleId) ?? WALL_STYLES[0]!;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const c = canvas.getContext('2d')!;
  // The same seed at every size, so a thumbnail looks like the wallpaper.
  const seed = hash(`${style.id}:${theme.id}`);
  style.draw(c, canvas.width, canvas.height, theme, seeded(seed));
  grain(c, canvas.width, canvas.height, seeded(seed ^ 0x9e3779b9), theme.dark);
  return canvas;
}
