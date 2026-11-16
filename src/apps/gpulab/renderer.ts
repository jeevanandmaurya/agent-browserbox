/** Wraps user fragment code in a fullscreen-triangle pipeline and draws it to a canvas. */

const PRELUDE = `struct Uniforms {
  resolution: vec2f,
  mouse: vec2f,
  time: f32,
  frame: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
`;

// fragCoord is flipped so (0,0) is bottom-left, matching Shadertoy conventions.
const EPILOGUE = `
@vertex fn bbx_vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn bbx_fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return mainImage(vec2f(pos.x, u.resolution.y - pos.y));
}
`;

const PRELUDE_LINES = PRELUDE.split('\n').length - 1;

export interface CompileError {
  /** 1-based line in the user's code, or null when the error is in the wrapper. */
  line: number | null;
  col: number;
  message: string;
}

export interface FrameUniforms {
  time: number;
  frame: number;
  mouse: [number, number];
}

export class ShaderRenderer {
  readonly format = navigator.gpu.getPreferredCanvasFormat();
  #ctx: GPUCanvasContext;
  #ubuf: GPUBuffer;
  #layout: GPUPipelineLayout;
  #bind: GPUBindGroup;
  #pipeline: GPURenderPipeline | null = null;
  #data = new Float32Array(8);
  #version = 0;

  constructor(
    readonly device: GPUDevice,
    readonly canvas: HTMLCanvasElement,
  ) {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas context');
    this.#ctx = ctx;
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.#ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgl = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this.#layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.#bind = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer: this.#ubuf } }] });
  }

  get ready(): boolean {
    return this.#pipeline !== null;
  }

  /**
   * Compiles user code. On success the new pipeline replaces the old one and
   * `[]` is returned; on failure the previous pipeline keeps running. Returns
   * null when a newer compile superseded this one.
   */
  async compile(src: string): Promise<CompileError[] | null> {
    const version = ++this.#version;
    const userLines = src.split('\n').length;
    const { device } = this;
    // Compile errors arrive via getCompilationInfo; the scope only keeps them out of the console.
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label: 'gpulab fragment', code: PRELUDE + src + EPILOGUE });
    const scope = device.popErrorScope();
    const info = await module.getCompilationInfo();
    await scope.catch(() => null);
    if (version !== this.#version) return null;
    const errors = info.messages
      .filter((m) => m.type === 'error')
      .map((m): CompileError => {
        const line = m.lineNum - PRELUDE_LINES;
        return { line: line >= 1 && line <= userLines ? line : null, col: m.linePos, message: m.message };
      });
    if (errors.length) return errors;
    try {
      const pipeline = await device.createRenderPipelineAsync({
        label: 'gpulab',
        layout: this.#layout,
        vertex: { module, entryPoint: 'bbx_vs' },
        fragment: { module, entryPoint: 'bbx_fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      });
      if (version !== this.#version) return null;
      this.#pipeline = pipeline;
      return [];
    } catch (err) {
      if (version !== this.#version) return null;
      return [{ line: null, col: 0, message: (err as Error)?.message || String(err) }];
    }
  }

  draw(u: FrameUniforms): void {
    const { canvas, device } = this;
    if (!this.#pipeline || canvas.width < 1 || canvas.height < 1) return;
    const d = this.#data;
    d[0] = canvas.width;
    d[1] = canvas.height;
    d[2] = u.mouse[0];
    d[3] = u.mouse[1];
    d[4] = u.time;
    d[5] = u.frame;
    device.queue.writeBuffer(this.#ubuf, 0, d);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.#ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  destroy(): void {
    this.#version++;
    this.#pipeline = null;
    this.#ubuf.destroy();
    try {
      this.#ctx.unconfigure();
    } catch {
      /* context already gone */
    }
  }
}
