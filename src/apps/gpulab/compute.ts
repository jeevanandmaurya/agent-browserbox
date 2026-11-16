import { gpuCompute } from '@/sandbox/gpu';
import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { codeEditor, errMsg, type Tab } from './common';
import { COMPUTE_PRESETS, generateInput, type ComputePreset, type Pattern } from './computePresets';
import { fmt, plotImage, plotLine } from './plot';

// Powers of four, so every size has an exact square W×H grid.
const SIZES: Array<[number, string]> = [
  [1 << 10, '1K'],
  [1 << 12, '4K'],
  [1 << 14, '16K'],
  [1 << 16, '64K'],
  [1 << 18, '256K'],
  [1 << 20, '1M'],
  [1 << 22, '4M'],
];
const MAX_GROUPS = 65535;

interface LastRun {
  out: Float32Array;
  w: number;
  h: number;
  image: boolean;
}

export function createComputeTab(ctx: AppContext): Tab {
  const { os } = ctx;
  let busy = false;
  let last: LastRun | null = null;
  /** The last preset loaded; its plot style survives edits. */
  let base: ComputePreset | undefined;

  const presetSel = h(
    'select',
    { class: 'select gl-narrow', 'aria-label': 'Preset', onchange: () => loadPreset(presetSel.value) },
    h('option', { value: '' }, 'Custom'),
    COMPUTE_PRESETS.map((p) => h('option', { value: p.id }, p.name)),
  );
  const sizeSel = h(
    'select',
    { class: 'select gl-narrow', 'aria-label': 'Element count N', title: 'Element count N' },
    SIZES.map(([n, label]) => h('option', { value: String(n), selected: n === 1 << 20 }, `N = ${label}`)),
  );
  const patternSel = h(
    'select',
    { class: 'select gl-narrow', 'aria-label': 'Input pattern', title: 'Input pattern' },
    h('option', { value: 'ramp' }, 'ramp'),
    h('option', { value: 'random' }, 'random'),
    h('option', { value: 'ones' }, 'ones'),
  );
  const cpuBox = h('input', { type: 'checkbox' });
  const runBtn = h('button', { class: 'btn small primary', onclick: () => void run() }, '▶ Run');
  const editor = codeEditor('WGSL compute shader', () => (presetSel.value = current()?.id ?? ''), () => void run());
  editor.title = 'Ctrl+S runs. Tab indents; press Esc, then Tab, to leave the editor.';

  const stats = h('dl', { class: 'gl-stats' });
  const values = h('pre', { class: 'gl-values mono', 'aria-label': 'First 16 output values' });
  const plot = h('canvas', { class: 'gl-plot', role: 'img', 'aria-label': 'Plot of the output' });
  const message = h('div', { class: 'gl-errors', role: 'status', 'aria-live': 'polite', hidden: true });
  const status = h('span', null, 'Ready');

  /** The selected preset, only if the code is unmodified. */
  function current(): ComputePreset | undefined {
    return COMPUTE_PRESETS.find((p) => p.code === editor.value);
  }

  function loadPreset(id: string): void {
    const p = COMPUTE_PRESETS.find((x) => x.id === id);
    if (!p) return;
    base = p;
    editor.value = p.code;
    patternSel.value = p.pattern;
  }

  function setStats(rows: Array<[string, string]>): void {
    stats.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, v)]));
  }

  function redraw(): void {
    if (!last) return;
    if (last.image) plotImage(plot, last.out, last.w, last.h);
    else plotLine(plot, last.out);
  }

  async function run(): Promise<void> {
    if (busy) return;
    const n = Number(sizeSel.value);
    const w = 1 << Math.round(Math.log2(n) / 2);
    const hgt = n / w;
    const src = editor.value;
    const ws = Number(/@workgroup_size\s*\(\s*(\d+)/.exec(src)?.[1] ?? 64);
    const groups = Math.ceil(n / Math.max(1, ws));
    message.hidden = true;
    if (groups > MAX_GROUPS) {
      message.hidden = false;
      message.textContent = `N / @workgroup_size = ${groups} workgroups, above the WebGPU limit of ${MAX_GROUPS}. Use a larger @workgroup_size (e.g. 256).`;
      return;
    }
    busy = true;
    runBtn.disabled = true;
    status.textContent = 'Running on GPU…';
    os.procs.update(ctx.proc.pid, { state: 'running', detail: `compute · N=${n}` });
    const preset = current();
    try {
      const input = generateInput(patternSel.value as Pattern, n);
      const header = `const N: u32 = ${n}u;\nconst W: u32 = ${w}u;\nconst H: u32 = ${hgt}u;\n`;
      let result;
      try {
        result = await gpuCompute({ wgsl: header + src, input, outputLength: n, workgroups: [groups] });
      } catch (err) {
        // gpuCompute reports "  line:col msg"; shift lines past our injected header.
        throw new Error(errMsg(err).replace(/^(\s*)(\d+):(\d+)/gm, (_m, sp: string, l: string, c: string) => `${sp}line ${Number(l) - 3}:${c}`));
      }
      if (ctx.proc.signal.aborted) return;
      const { output, ms } = result;
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      for (const v of output) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
      }
      const rows: Array<[string, string]> = [
        ['GPU time', `${ms.toFixed(2)} ms`],
        ['Throughput', `${(n / ms / 1e3).toFixed(1)} M elem/s · ${((n * 8) / ms / 1e6).toFixed(2)} GB/s`],
        ['min / max', `${fmt(lo)} / ${fmt(hi)}`],
        ['sum', fmt(sum)],
      ];
      values.textContent = Array.from(output.subarray(0, 16), (v, i) => `[${String(i).padStart(2)}] ${fmt(v)}`).join('\n');
      last = { out: output, w, h: hgt, image: !!base?.image };
      redraw();

      if (cpuBox.checked) {
        if (!preset) rows.push(['CPU', 'only available for unmodified presets']);
        else {
          status.textContent = 'Running on CPU…';
          await new Promise((r) => setTimeout(r, 16)); // let the GPU results paint first
          const t0 = performance.now();
          const ref = preset.cpu(input, n, w, hgt);
          const cpuMs = performance.now() - t0;
          let maxDiff = 0;
          let ok = 0;
          for (let i = 0; i < n; i++) {
            const d = Math.abs(ref[i]! - output[i]!);
            if (d > maxDiff) maxDiff = d;
            if (d <= 1e-3 * Math.max(1, Math.abs(ref[i]!))) ok++;
          }
          rows.push(['CPU time', `${cpuMs.toFixed(2)} ms`], ['Speed-up', `${(cpuMs / ms).toFixed(1)}× ${cpuMs > ms ? 'faster on GPU' : 'faster on CPU'}`], ['Agreement', `${((ok / n) * 100).toFixed(2)}% within 1e-3 · max |Δ| ${fmt(maxDiff)}`]);
        }
      }
      setStats(rows);
      status.textContent = `Done · GPU time includes compile, upload and readback`;
    } catch (err) {
      message.hidden = false;
      message.textContent = errMsg(err);
      status.textContent = 'Failed';
    } finally {
      busy = false;
      runBtn.disabled = false;
      os.procs.update(ctx.proc.pid, { state: 'idle', detail: 'compute' });
    }
  }

  const el = h(
    'div',
    { class: 'gl-tab' },
    h(
      'div',
      { class: 'toolbar gl-toolbar' },
      presetSel,
      sizeSel,
      patternSel,
      h('label', { class: 'row gl-check' }, cpuBox, 'Compare with CPU'),
      h('div', { class: 'spacer' }),
      runBtn,
    ),
    h(
      'div',
      { class: 'gl-split fill' },
      h(
        'div',
        { class: 'gl-pane gl-editor-pane' },
        editor,
        h('div', { class: 'gl-hint muted' }, 'Injected: const N, W, H: u32 (N = W×H). Bindings: 0 src (read), 1 dst (read_write). Entry point: main.'),
        message,
      ),
      h('div', { class: 'gl-pane gl-results' }, stats, h('div', { class: 'gl-plot-wrap' }, plot), values),
    ),
    h('div', { class: 'statusbar' }, status),
  );

  const ro = new ResizeObserver(() => redraw());
  ro.observe(plot);
  setStats([['', 'Pick a preset and press Run.']]);
  const first = COMPUTE_PRESETS[0]!;
  presetSel.value = first.id;
  loadPreset(first.id);

  return {
    el,
    setActive() {},
    dispose() {
      ro.disconnect();
    },
  };
}
