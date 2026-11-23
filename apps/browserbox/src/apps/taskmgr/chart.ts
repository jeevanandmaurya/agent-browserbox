/** Tiny canvas line chart for live sparklines. Colours come from CSS variables so themes apply on the next draw. */

export interface SeriesSpec {
  label: string;
  /** CSS custom property name, e.g. '--accent'. */
  color: string;
}

export interface ChartOptions {
  series: SeriesSpec[];
  /** Number of samples kept (one per second → 60 = one minute). */
  capacity: number;
  /** Fixed y-axis maximum; when omitted the axis scales to the data. */
  max?: number;
  /** Fill the area under the first series. */
  area?: boolean;
  label: string;
}

export interface Chart {
  el: HTMLCanvasElement;
  push(values: number[]): void;
  setMax(max: number | undefined): void;
  draw(): void;
}

export function createChart(opts: ChartOptions): Chart {
  const canvas = document.createElement('canvas');
  canvas.className = 'tm-chart';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', opts.label);
  const data: number[][] = opts.series.map(() => []);
  let max = opts.max;
  let w = 0;
  let hgt = 0;

  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const cw = Math.round(w * dpr);
    const ch = Math.round(hgt * dpr);
    if (!cw || !ch) return;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const color = (v: string) => css.getPropertyValue(v).trim() || '#888';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);

    ctx.strokeStyle = color('--border');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(hgt * f) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    const top = max ?? Math.max(1, ...data.flat()) * 1.15;
    const step = w / Math.max(1, opts.capacity - 1);
    const pad = 2;
    const yOf = (v: number) => pad + (hgt - 2 * pad) * (1 - Math.min(1, Math.max(0, v / top)));
    data.forEach((vals, si) => {
      if (!vals.length) return;
      // Right-align so the newest sample is always at the right edge.
      const x0 = w - (vals.length - 1) * step;
      ctx.beginPath();
      vals.forEach((v, i) => (i ? ctx.lineTo(x0 + i * step, yOf(v)) : ctx.moveTo(x0, yOf(v))));
      const c = color(opts.series[si]!.color);
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (opts.area && si === 0) {
        ctx.lineTo(w, hgt);
        ctx.lineTo(x0, hgt);
        ctx.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = c;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });
  };

  new ResizeObserver(([entry]) => {
    if (!entry) return;
    w = entry.contentRect.width;
    hgt = entry.contentRect.height;
    draw();
  }).observe(canvas);

  return {
    el: canvas,
    push(values) {
      values.forEach((v, i) => {
        const arr = data[i];
        if (!arr) return;
        arr.push(Number.isFinite(v) ? v : 0);
        if (arr.length > opts.capacity) arr.shift();
      });
      draw();
    },
    setMax(m) {
      max = m;
    },
    draw,
  };
}
