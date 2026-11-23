import './style.css';
import { getDevice, gpuAvailable } from '@/app/gpu';
import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';
import { errMsg, gpuHelp, type Tab } from './common';
import { createComputeTab } from './compute';
import { createShaderTab } from './shader';

type TabId = 'shader' | 'compute';

const app: AppModule = {
  async mount(ctx) {
    if (!gpuAvailable()) {
      ctx.root.append(gpuHelp('This browser does not expose WebGPU (navigator.gpu is missing).'));
      return;
    }
    const loading = h('div', { class: 'empty' }, 'Starting WebGPU…');
    ctx.root.append(loading);
    let device: GPUDevice;
    try {
      device = await getDevice();
    } catch (err) {
      loading.replaceWith(gpuHelp(`Requesting a GPU failed: ${errMsg(err)}.`));
      return;
    }
    if (ctx.proc.signal.aborted) return;
    loading.remove();

    const path = typeof ctx.args.path === 'string' ? ctx.args.path : undefined;
    const tabs: Partial<Record<TabId, Tab>> = { shader: createShaderTab(ctx, device, path) };
    const body = h('div', { class: 'gl-body fill' }, tabs.shader!.el);
    const buttons = {} as Record<TabId, HTMLButtonElement>;
    let activeId: TabId = 'shader';

    function select(id: TabId, focus = false): void {
      if (!tabs[id]) {
        tabs[id] = createComputeTab(ctx);
        body.append(tabs[id]!.el);
      }
      activeId = id;
      for (const [k, tab] of Object.entries(tabs) as Array<[TabId, Tab]>) {
        const on = k === id;
        tab.el.hidden = !on;
        tab.setActive(on);
        buttons[k].setAttribute('aria-selected', String(on));
        buttons[k].tabIndex = on ? 0 : -1;
      }
      body.setAttribute('aria-labelledby', buttons[id].id);
      if (focus) buttons[id].focus();
    }

    const tabBtn = (id: TabId, label: string) =>
      (buttons[id] = h('button', { class: 'gl-tabbtn', role: 'tab', id: `gl-tab-${id}-${ctx.proc.pid}`, onclick: () => select(id) }, label));
    const tablist = h('div', { class: 'gl-tabs', role: 'tablist', 'aria-label': 'GPU Lab mode' }, tabBtn('shader', 'Shader'), tabBtn('compute', 'Compute'));
    tablist.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') select(activeId === 'shader' ? 'compute' : 'shader', true);
    });
    body.setAttribute('role', 'tabpanel');
    ctx.root.append(tablist, body);
    select('shader');

    return () => {
      for (const tab of Object.values(tabs)) tab?.dispose();
    };
  },
};
export default app;
