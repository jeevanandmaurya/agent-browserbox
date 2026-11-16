/** Tiny canvas plots for compute output, downsampled to the canvas width. */

function setup(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const r = canvas.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  canvas.width = Math.round(r.width * devicePixelRatio);
  canvas.height = Math.round(r.height * devicePixelRatio);
  const g = canvas.getContext('2d');
  g?.clearRect(0, 0, canvas.width, canvas.height);
  return g;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Min/max envelope per pixel column, so spikes survive downsampling. */
export function plotLine(canvas: HTMLCanvasElement, data: Float32Array): void {
  const g = setup(canvas);
  if (!g || !data.length) return;
  const W = canvas.width;
  const H = canvas.height;
  const pad = Math.round(6 * devicePixelRatio);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of data) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return;
  if (hi === lo) hi = lo + 1;
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  g.strokeStyle = cssVar(canvas, '--accent', '#7c5cff');
  g.lineWidth = Math.max(1, devicePixelRatio);
  g.beginPath();
  const cols = Math.min(W, data.length);
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * data.length) / cols);
    const b = Math.max(a + 1, Math.floor(((c + 1) * data.length) / cols));
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = a; i < b; i++) {
      const v = data[i]!;
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) continue;
    const x = cols === 1 ? W / 2 : (c / (cols - 1)) * (W - 1) + 0.5;
    if (c === 0) g.moveTo(x, y(mn));
    g.lineTo(x, y(mn));
    g.lineTo(x, y(mx) - 0.5);
  }
  g.stroke();
  g.fillStyle = cssVar(canvas, '--muted', '#888');
  g.font = `${11 * devicePixelRatio}px ${cssVar(canvas, '--mono', 'monospace')}`;
  g.fillText(fmt(hi), pad, pad + 10 * devicePixelRatio);
  g.fillText(fmt(lo), pad, H - pad);
}

/** Renders a W×H grid with a cosine palette, normalised to the max value. */
export function plotImage(canvas: HTMLCanvasElement, data: Float32Array, w: number, h: number): void {
  const g = setup(canvas);
  if (!g || !data.length) return;
  const fit = Math.min(canvas.width / w, canvas.height / h);
  const tw = Math.max(1, Math.min(w, Math.floor(w * fit)));
  const th = Math.max(1, Math.min(h, Math.floor(h * fit)));
  let hi = 0;
  for (const v of data) if (Number.isFinite(v) && v > hi) hi = v;
  const img = new ImageData(tw, th);
  for (let y = 0; y < th; y++) {
    // Flip so +y points up, like the complex plane.
    const sy = Math.floor(((th - 1 - y) * h) / th);
    for (let x = 0; x < tw; x++) {
      const v = data[sy * w + Math.floor((x * w) / tw)] ?? 0;
      const o = (y * tw + x) * 4;
      const t = hi ? v / hi : 0;
      const inside = t >= 1;
      const s = Math.sqrt(t) * 6.2831;
      img.data[o] = inside ? 0 : 255 * (0.5 + 0.5 * Math.cos(3 + s));
      img.data[o + 1] = inside ? 0 : 255 * (0.5 + 0.5 * Math.cos(3.6 + s));
      img.data[o + 2] = inside ? 0 : 255 * (0.5 + 0.5 * Math.cos(4 + s));
      img.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement('canvas');
  tmp.width = tw;
  tmp.height = th;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  const dw = w * fit;
  const dh = h * fit;
  g.imageSmoothingEnabled = tw < dw;
  g.drawImage(tmp, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(3);
  return Number(v.toFixed(4)).toString();
}
