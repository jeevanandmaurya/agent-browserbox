import { getDevice } from '@/sandbox/gpu';
import type { AppContext } from '@/ui/apps';
import { confirmDialog, promptDialog } from '@/ui/dialog';
import { debounce, h } from '@/ui/dom';
import { codeEditor, DOCS, errMsg, gotoLine, safeName, stamp, type Tab } from './common';
import { SHADER_PRESETS } from './presets';
import { ShaderRenderer, type CompileError } from './renderer';

export function createShaderTab(ctx: AppContext, initialDevice: GPUDevice, initialPath?: string): Tab {
  const { os } = ctx;
  let renderer: ShaderRenderer | null = null;
  let active = true;
  let playing = true;
  let scale = 1;
  let time = 0;
  let frame = 0;
  let last = 0;
  let needsDraw = true;
  let mouse: [number, number] = [0, 0];
  let filePath: string | null = null;
  let raf = 0;
  let reported = '';
  // FPS window
  let fpsFrames = 0;
  let fpsStart = 0;
  let fpsValue = 0;
  let frameMs = 0;

  const canvas = h('canvas', { class: 'gl-canvas', 'aria-label': 'Shader output. Move the pointer to set u.mouse.' });
  const canvasWrap = h('div', { class: 'gl-canvas-wrap' }, canvas);
  const errors = h('div', { class: 'gl-errors', role: 'status', 'aria-live': 'polite', hidden: true });
  const status = h('span', null, 'Compiling…');
  const fpsEl = h('span', { class: 'mono' }, '— fps');
  const resEl = h('span', { class: 'mono' }, '');
  const lostBox = h('div', { class: 'gl-lost', hidden: true });

  const presetSel = h(
    'select',
    { class: 'select gl-narrow', 'aria-label': 'Preset', onchange: () => loadPreset(presetSel.value) },
    h('option', { value: '' }, 'Custom'),
    SHADER_PRESETS.map((p) => h('option', { value: p.id }, p.name)),
  );
  const playBtn = h('button', { class: 'btn small', onclick: () => setPlaying(!playing) });
  const scaleSel = h(
    'select',
    {
      class: 'select gl-narrow',
      'aria-label': 'Resolution scale',
      title: 'Resolution scale',
      onchange: () => {
        scale = Number(scaleSel.value);
        resize();
      },
    },
    h('option', { value: '0.5' }, '0.5×'),
    h('option', { value: '1', selected: true }, '1×'),
    h('option', { value: '2' }, '2×'),
  );

  const recompile = debounce(() => void compile(), 400);
  const editor = codeEditor('WGSL fragment shader', () => {
    presetSel.value = matchPreset(editor.value);
    status.textContent = 'Editing…';
    recompile();
  }, () => void save());

  function matchPreset(code: string): string {
    return SHADER_PRESETS.find((p) => p.code === code)?.id ?? '';
  }

  function setPlaying(on: boolean): void {
    playing = on;
    playBtn.textContent = on ? '❚❚ Pause' : '▶ Play';
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    last = 0;
    needsDraw = true;
  }

  function resetTime(): void {
    time = 0;
    frame = 0;
    needsDraw = true;
  }

  function showErrors(list: CompileError[]): void {
    errors.hidden = list.length === 0;
    errors.replaceChildren(
      ...list.map((e) =>
        e.line === null
          ? h('div', { class: 'gl-err' }, h('span', { class: 'gl-err-loc' }, 'wrapper'), e.message)
          : h('button', { class: 'gl-err', onclick: () => gotoLine(editor, e.line!, e.col) }, h('span', { class: 'gl-err-loc' }, `line ${e.line}:${e.col}`), e.message),
      ),
    );
  }

  async function compile(): Promise<void> {
    if (!renderer) return;
    status.textContent = 'Compiling…';
    const result = await renderer.compile(editor.value);
    if (result === null) return; // superseded
    showErrors(result);
    status.textContent = result.length ? `${result.length} error${result.length > 1 ? 's' : ''}${renderer.ready ? ' — showing last good shader' : ''}` : 'Compiled';
    needsDraw = true;
  }

  function loadPreset(id: string): void {
    const p = SHADER_PRESETS.find((x) => x.id === id);
    if (!p) return;
    editor.value = p.code;
    filePath = null;
    ctx.win.setTitle('GPU Lab');
    time = 0;
    frame = 0;
    void compile();
  }

  function resize(): void {
    const r = canvasWrap.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || !renderer) return;
    const max = renderer.device.limits.maxTextureDimension2D;
    const k = devicePixelRatio * scale;
    canvas.width = Math.max(1, Math.min(max, Math.round(r.width * k)));
    canvas.height = Math.max(1, Math.min(max, Math.round(r.height * k)));
    resEl.textContent = `${canvas.width}×${canvas.height}`;
    needsDraw = true;
  }

  function report(state: 'running' | 'idle', detail: string): void {
    const key = state + detail;
    if (key === reported) return;
    reported = key;
    os.procs.update(ctx.proc.pid, { state, detail });
  }

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    const visible = active && !ctx.win.minimized && !document.hidden && renderer !== null;
    if (!visible) {
      last = 0;
      report('idle', ctx.win.minimized || document.hidden ? 'shader (paused: hidden)' : 'idle');
      return;
    }
    if (!playing && !needsDraw) {
      report('idle', 'shader (paused)');
      return;
    }
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (playing) time += dt;
    renderer!.draw({ time, frame, mouse });
    needsDraw = false;
    if (!playing) return;
    frame++;
    fpsFrames++;
    if (!fpsStart) fpsStart = now;
    if (now - fpsStart >= 500) {
      fpsValue = (fpsFrames * 1000) / (now - fpsStart);
      frameMs = (now - fpsStart) / fpsFrames;
      fpsFrames = 0;
      fpsStart = now;
      fpsEl.textContent = `${fpsValue.toFixed(0)} fps · ${frameMs.toFixed(1)} ms`;
      report('running', `shader · ${fpsValue.toFixed(0)} fps`);
    }
  }

  function attach(device: GPUDevice): void {
    renderer?.destroy();
    renderer = new ShaderRenderer(device, canvas);
    lostBox.hidden = true;
    void device.lost.then((info) => {
      if (info.reason === 'destroyed' || ctx.proc.signal.aborted || renderer?.device !== device) return;
      renderer = null;
      status.textContent = 'GPU device lost';
      lostBox.hidden = false;
      lostBox.replaceChildren(
        h('p', null, 'The GPU device was lost', info.message ? ` (${info.message})` : '', '.'),
        h('button', { class: 'btn primary', onclick: () => void restart() }, 'Restart'),
      );
    });
    resize();
    void compile();
  }

  async function restart(): Promise<void> {
    try {
      attach(await getDevice());
    } catch (err) {
      os.notify({ title: 'Could not restart WebGPU', body: errMsg(err), level: 'error' });
    }
  }

  async function save(): Promise<void> {
    const suggested = filePath ? filePath.split('/').pop()!.replace(/\.wgsl$/i, '') : presetSel.value || 'shader';
    const name = await promptDialog('Save shader', `File name (saved in ${DOCS})`, suggested);
    if (name === null) return;
    const stem = safeName(name);
    if (!stem) return os.notify({ title: 'Invalid file name', level: 'warn' });
    const path = `${DOCS}/${stem}.wgsl`;
    try {
      if (path !== filePath && (await os.fs.exists(path)) && !(await confirmDialog('Replace file?', `${path} already exists.`, 'Replace', true))) return;
      await os.fs.writeFile(path, editor.value);
      filePath = path;
      ctx.win.setTitle(`GPU Lab — ${stem}.wgsl`);
      os.notify({ title: 'Shader saved', body: path, level: 'ok' });
    } catch (err) {
      os.notify({ title: 'Save failed', body: errMsg(err), level: 'error' });
    }
  }

  async function open(path?: string): Promise<void> {
    path ??= (await promptDialog('Open shader', 'Path to a .wgsl file', filePath ?? `${DOCS}/`)) ?? undefined;
    if (!path) return;
    try {
      const code = await os.fs.readText(path);
      editor.value = code;
      filePath = path;
      presetSel.value = matchPreset(code);
      ctx.win.setTitle(`GPU Lab — ${path.split('/').pop()}`);
      time = 0;
      frame = 0;
      void compile();
    } catch (err) {
      os.notify({ title: `Could not open ${path}`, body: errMsg(err), level: 'error' });
    }
  }

  async function snapshot(): Promise<void> {
    if (!renderer?.ready) return os.notify({ title: 'Nothing to snapshot yet', level: 'warn' });
    // A WebGPU canvas is only readable in the task that rendered it, so draw and capture together.
    renderer.draw({ time, frame, mouse });
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return os.notify({ title: 'Snapshot failed', level: 'error' });
    const path = `${DOCS}/gpulab-${stamp()}.png`;
    try {
      await os.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      os.notify({ title: 'Snapshot saved', body: path, level: 'ok' });
    } catch (err) {
      os.notify({ title: 'Snapshot failed', body: errMsg(err), level: 'error' });
    }
  }

  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (r.width < 1) return;
    mouse = [((e.clientX - r.left) * canvas.width) / r.width, ((r.bottom - e.clientY) * canvas.height) / r.height];
    if (!playing) needsDraw = true;
  };
  canvas.addEventListener('pointermove', onPointer);
  canvas.addEventListener('pointerdown', onPointer);

  const el = h(
    'div',
    { class: 'gl-tab' },
    h(
      'div',
      { class: 'toolbar gl-toolbar' },
      presetSel,
      playBtn,
      h('button', { class: 'btn small', onclick: resetTime, title: 'Reset time to zero' }, '⟲ Reset'),
      scaleSel,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => void open() }, 'Open…'),
      h('button', { class: 'btn small', onclick: () => void save(), title: 'Save (Ctrl+S)' }, 'Save'),
      h('button', { class: 'btn small', onclick: () => void snapshot(), title: `Save a PNG to ${DOCS}` }, 'Snapshot'),
    ),
    h('div', { class: 'gl-split fill' }, h('div', { class: 'gl-pane gl-editor-pane' }, editor, errors), h('div', { class: 'gl-pane gl-view-pane' }, canvasWrap, lostBox)),
    h('div', { class: 'statusbar' }, status, h('div', { class: 'spacer fill' }), resEl, fpsEl),
  );

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap);
  const onDpr = () => resize();
  const dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  dprQuery.addEventListener('change', onDpr);

  setPlaying(true);
  const first = SHADER_PRESETS[0]!;
  editor.value = first.code;
  presetSel.value = first.id;
  attach(initialDevice);
  if (initialPath) void open(initialPath);
  raf = requestAnimationFrame(tick);

  return {
    el,
    setActive(on) {
      active = on;
      last = 0;
      needsDraw = true;
      if (on) requestAnimationFrame(() => resize());
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dprQuery.removeEventListener('change', onDpr);
      renderer?.destroy();
      renderer = null;
    },
  };
}
