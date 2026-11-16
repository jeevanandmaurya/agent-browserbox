import { adapterInfo, gpuAvailable, gpuCompute } from '@/sandbox/gpu';
import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { errText, heading, kvList } from './nav';

const LIMITS: Array<[keyof GPUSupportedLimits, string, boolean]> = [
  ['maxBufferSize', 'Max buffer size', true],
  ['maxStorageBufferBindingSize', 'Max storage buffer binding', true],
  ['maxUniformBufferBindingSize', 'Max uniform buffer binding', true],
  ['maxComputeWorkgroupStorageSize', 'Workgroup shared memory', true],
  ['maxComputeInvocationsPerWorkgroup', 'Invocations per workgroup', false],
  ['maxComputeWorkgroupSizeX', 'Workgroup size X', false],
  ['maxComputeWorkgroupsPerDimension', 'Workgroups per dimension', false],
  ['maxStorageBuffersPerShaderStage', 'Storage buffers per stage', false],
  ['maxTextureDimension2D', 'Max 2D texture size', false],
  ['maxBindGroups', 'Bind groups', false],
];

const N = 1 << 20; // ~1M floats
const ITER = 64; // repeated SAXPY so the work is compute- rather than transfer-bound
const A = 0.5;
const WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= ${N}u) { return; }
  let x = src[i];
  var y = src[${N}u + i];
  for (var k = 0u; k < ${ITER}u; k++) { y = ${A.toFixed(1)} * y + x; }
  dst[i] = y;
}`;

function cpuSaxpy(x: Float32Array, y0: Float32Array): Float32Array {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const xi = x[i]!;
    let y = y0[i]!;
    for (let k = 0; k < ITER; k++) y = Math.fround(A * y + xi);
    out[i] = y;
  }
  return out;
}

const fmtMs = (ms: number) => `${ms < 10 ? ms.toFixed(2) : ms.toFixed(0)} ms`;

export function gpu(ctx: AppContext): HTMLElement {
  if (!gpuAvailable()) {
    return h(
      'div',
      { class: 'si-section' },
      heading('GPU'),
      h(
        'div',
        { class: 'card' },
        h('p', null, 'WebGPU is not available in this browser.'),
        h('p', { class: 'muted' }, 'GPU compute, GPU Lab and in-browser models need it. Recent Chrome, Edge and Safari support WebGPU; Firefox has it on some platforms. It may also be disabled by policy or unavailable on this graphics driver.'),
      ),
    );
  }

  const info = h('div', null, h('p', { class: 'muted' }, 'Querying adapter…'));
  const limits = h('div');
  const features = h('div', { class: 'si-features' });
  const result = h('div', { class: 'si-bench-result', 'aria-live': 'polite' });
  const benchBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => void bench() }, 'Run benchmark');

  void (async () => {
    try {
      const [ai, adapter] = await Promise.all([adapterInfo().catch(() => ({}) as Record<string, string>), navigator.gpu.requestAdapter()]);
      if (!adapter) {
        info.replaceChildren(h('p', null, h('span', { class: 'badge warn' }, 'no adapter'), ' WebGPU is present but no GPU adapter is available (blocklisted driver or headless mode).'));
        benchBtn.disabled = true;
        return;
      }
      const rows = Object.entries(ai).filter(([, v]) => v) as Array<[string, string]>;
      info.replaceChildren(kvList(rows.length ? rows.map(([k, v]) => [k[0]!.toUpperCase() + k.slice(1), v]) : [['Adapter', 'details hidden by the browser']]));
      const l = adapter.limits;
      limits.replaceChildren(kvList(LIMITS.map(([k, label, bytes]) => [label, h('span', { class: 'mono' }, bytes ? fmtBytes(Number(l[k])) : Number(l[k]).toLocaleString())])));
      const feats = [...adapter.features].sort() as string[];
      features.replaceChildren(
        h('p', null, 'Half-precision shaders (f16): ', h('span', { class: `badge ${adapter.features.has('shader-f16') ? 'ok' : ''}` }, adapter.features.has('shader-f16') ? 'supported' : 'not supported')),
        feats.length ? h('ul', { class: 'si-chips' }, feats.map((f) => h('li', { class: 'badge mono' }, f))) : h('p', { class: 'muted' }, 'No optional features.'),
      );
    } catch (err) {
      info.replaceChildren(h('p', { class: 'muted' }, `Could not query the GPU: ${errText(err)}`));
    }
  })();

  async function bench(): Promise<void> {
    benchBtn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, 'Running on the GPU…'));
    try {
      const input = new Float32Array(2 * N);
      for (let i = 0; i < 2 * N; i++) input[i] = (i % 1000) / 1000;
      // First run pays for device creation and pipeline setup; time the second.
      await gpuCompute({ wgsl: WGSL, input, outputLength: N });
      if (ctx.proc.signal.aborted) return;
      const g = await gpuCompute({ wgsl: WGSL, input, outputLength: N });
      if (ctx.proc.signal.aborted) return;
      result.replaceChildren(h('p', { class: 'muted' }, 'Running the same loop on the CPU…'));
      await new Promise((r) => setTimeout(r, 30)); // let the status paint before the blocking loop
      const t0 = performance.now();
      const c = cpuSaxpy(input.subarray(0, N), input.subarray(N));
      const cpuMs = performance.now() - t0;
      let maxErr = 0;
      for (let i = 0; i < N; i += 97) maxErr = Math.max(maxErr, Math.abs(g.output[i]! - c[i]!) / Math.max(1, Math.abs(c[i]!)));
      const ratio = cpuMs / g.ms;
      result.replaceChildren(
        kvList([
          ['GPU', h('strong', { class: 'mono' }, fmtMs(g.ms))],
          ['CPU (main thread)', h('strong', { class: 'mono' }, fmtMs(cpuMs))],
          ['Result', h('span', null, ratio >= 1 ? `GPU ${ratio.toFixed(1)}× faster` : `CPU ${(1 / ratio).toFixed(1)}× faster`)],
          ['Agreement', h('span', { class: `badge ${maxErr < 1e-4 ? 'ok' : 'warn'}` }, maxErr < 1e-4 ? 'results match' : `max rel. error ${maxErr.toExponential(1)}`)],
        ]),
        h('p', { class: 'muted si-note' }, `${(N / 1e6).toFixed(2)}M elements × ${ITER} SAXPY iterations. GPU time includes shader compile, upload and read-back.`),
      );
    } catch (err) {
      result.replaceChildren(h('p', { class: 'si-error' }, `Benchmark failed: ${errText(err)}`));
    } finally {
      benchBtn.disabled = false;
    }
  }

  return h(
    'div',
    { class: 'si-section' },
    heading('GPU', 'WebGPU adapter'),
    info,
    h('h3', null, 'Limits'),
    limits,
    h('h3', null, 'Features'),
    features,
    h('h3', null, 'Compute benchmark'),
    h('div', { class: 'card col' }, h('p', { class: 'muted si-note' }, 'Runs y = a·y + x over ~1M floats on the GPU and on the CPU, and compares the times.'), h('div', { class: 'row' }, benchBtn), result),
  );
}
