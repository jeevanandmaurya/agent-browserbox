/** WebGPU helpers shared by the agent's gpu_compute tool, the shell and GPU Lab. */

let devicePromise: Promise<GPUDevice> | null = null;

export function gpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function getDevice(): Promise<GPUDevice> {
  return (devicePromise ??= (async () => {
    if (!gpuAvailable()) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice();
    void device.lost.then(() => (devicePromise = null));
    return device;
  })().catch((err) => {
    devicePromise = null;
    throw err;
  }));
}

export async function adapterInfo(): Promise<Record<string, string>> {
  if (!gpuAvailable()) return {};
  const adapter = await navigator.gpu.requestAdapter();
  const info = adapter?.info;
  return info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : {};
}

export interface ComputeRequest {
  /**
   * WGSL with a `@compute` entry point named `main`.
   * `@group(0) @binding(0)` is a read-only `array<f32>` (input),
   * `@group(0) @binding(1)` is a read-write `array<f32>` (output).
   */
  wgsl: string;
  input: ArrayLike<number>;
  outputLength: number;
  /** Dispatch size; defaults to ceil(outputLength / 64) in x. */
  workgroups?: [number, number?, number?];
}

export interface ComputeResult {
  output: Float32Array;
  ms: number;
}

const MAX_ELEMENTS = 16 * 1024 * 1024;

/** Runs a compute shader over f32 buffers and reads the result back. */
export async function gpuCompute(req: ComputeRequest): Promise<ComputeResult> {
  if (!Number.isInteger(req.outputLength) || req.outputLength < 1 || req.outputLength > MAX_ELEMENTS) throw new Error(`outputLength must be 1..${MAX_ELEMENTS}`);
  if (req.input.length > MAX_ELEMENTS) throw new Error(`input is limited to ${MAX_ELEMENTS} elements`);
  const device = await getDevice();
  const started = performance.now();
  device.pushErrorScope('validation');

  const module = device.createShaderModule({ code: req.wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    void device.popErrorScope();
    throw new Error('WGSL compile error:\n' + errors.map((m) => `  ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  }

  const input = new Float32Array(Math.max(1, req.input.length));
  input.set(req.input);
  const inBuf = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(inBuf, 0, input);
  const outBytes = req.outputLength * 4;
  const outBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  try {
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    const [x, y = 1, z = 1] = req.workgroups ?? [Math.ceil(req.outputLength / 64)];
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
    encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes);
    device.queue.submit([encoder.finish()]);
    const err = await device.popErrorScope();
    if (err) throw new Error(`WebGPU validation error: ${err.message}`);
    await readBuf.mapAsync(GPUMapMode.READ);
    const output = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return { output, ms: performance.now() - started };
  } finally {
    inBuf.destroy();
    outBuf.destroy();
    readBuf.destroy();
  }
}
