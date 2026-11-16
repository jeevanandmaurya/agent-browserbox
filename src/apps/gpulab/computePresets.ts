/**
 * Compute presets. The app prepends `const N: u32`, `const W: u32` and
 * `const H: u32` (element count and a near-square W×H grid) to the code.
 */

export type Pattern = 'ramp' | 'random' | 'ones';

export interface ComputePreset {
  id: string;
  name: string;
  code: string;
  pattern: Pattern;
  /** Plot the output as a W×H image instead of a line. */
  image?: boolean;
  /** Equivalent JS implementation, used by "Compare with CPU". */
  cpu(src: Float32Array, n: number, w: number, h: number): Float32Array;
}

const BINDINGS = `@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
`;

const saxpy = `// SAXPY: dst = A * x + y, with y taken as the input read backwards.
${BINDINGS}
const A: f32 = 2.5;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= N) { return; }
  dst[i] = A * src[i] + src[N - 1u - i];
}
`;

const fourier = `// Sine map: 32-harmonic Fourier series of a sawtooth, per element.
${BINDINGS}
const K: i32 = 32;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= N) { return; }
  let x = src[i] * 6.2831853;
  var acc = 0.0;
  for (var k = 1; k <= K; k++) {
    acc += sin(f32(k) * x) / f32(k);
  }
  dst[i] = acc;
}
`;

const blur = `// 1D box blur: a stencil averaging 2R+1 neighbours (edges clamp).
${BINDINGS}
const R: i32 = 16;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= N) { return; }
  let i = i32(id.x);
  var acc = 0.0;
  for (var k = -R; k <= R; k++) {
    acc += src[clamp(i + k, 0, i32(N) - 1)];
  }
  dst[id.x] = acc / f32(2 * R + 1);
}
`;

const mandel = `// Mandelbrot escape-iteration counts over a W×H grid.
${BINDINGS}
const MAX_ITER: u32 = 128u;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= N) { return; }
  _ = src[0]; // keeps binding 0 in the auto-generated layout
  let c = vec2f(-2.2 + 3.0 * f32(i % W) / f32(W), -1.5 + 3.0 * f32(i / W) / f32(H));
  var z = vec2f(0.0);
  var n = 0u;
  loop {
    if (n >= MAX_ITER || dot(z, z) > 4.0) { break; }
    z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    n++;
  }
  dst[i] = f32(n);
}
`;

export const COMPUTE_PRESETS: ComputePreset[] = [
  {
    id: 'saxpy',
    name: 'SAXPY',
    code: saxpy,
    pattern: 'ramp',
    cpu(src, n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = 2.5 * src[i]! + src[n - 1 - i]!;
      return out;
    },
  },
  {
    id: 'fourier',
    name: 'Sine map (Fourier)',
    code: fourier,
    pattern: 'ramp',
    cpu(src, n) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = src[i]! * 6.2831853;
        let acc = 0;
        for (let k = 1; k <= 32; k++) acc += Math.sin(k * x) / k;
        out[i] = acc;
      }
      return out;
    },
  },
  {
    id: 'blur',
    name: '1D blur stencil',
    code: blur,
    pattern: 'random',
    cpu(src, n) {
      const R = 16;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = -R; k <= R; k++) acc += src[Math.min(n - 1, Math.max(0, i + k))]!;
        out[i] = acc / (2 * R + 1);
      }
      return out;
    },
  },
  {
    id: 'mandelbrot',
    name: 'Mandelbrot grid',
    code: mandel,
    pattern: 'ones',
    image: true,
    cpu(_src, n, w, h) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const cx = Math.fround(-2.2 + (3 * (i % w)) / w);
        const cy = Math.fround(-1.5 + (3 * Math.floor(i / w)) / h);
        let x = 0;
        let y = 0;
        let it = 0;
        while (it < 128 && x * x + y * y <= 4) {
          const nx = Math.fround(x * x - y * y + cx);
          y = Math.fround(2 * x * y + cy);
          x = nx;
          it++;
        }
        out[i] = it;
      }
      return out;
    },
  },
];

export function generateInput(pattern: Pattern, n: number): Float32Array {
  const a = new Float32Array(n);
  if (pattern === 'ones') a.fill(1);
  else if (pattern === 'random') for (let i = 0; i < n; i++) a[i] = Math.random();
  else for (let i = 0; i < n; i++) a[i] = i / n;
  return a;
}
