import type { AgentConfig } from '@/agent/config';
import { catalogue, download, downloadedIds, importFolder, remove, type ModelEntry } from '@/agent/providers/webllm-store';
import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { loader } from '@/ui/icons';
import { confirmDialog } from '@/ui/dialog';
import { errText } from './nav';

const pretty = (id: string) => id.replace(/-q4f16_1-MLC$|-MLC$/, '').replace(/-/g, ' ');

/**
 * Models that run in this tab on WebGPU: download, use, delete, import a
 * compiled model from a folder, and free the GPU memory of a loaded one.
 */
export function webllmManager(ctx: AppContext, cfg: () => AgentConfig, save: (patch: Partial<AgentConfig>) => void): HTMLElement {
  const { os } = ctx;
  const gpuOk = os.hasCap('webgpu');
  const list = h('div', { class: 'wl-list', role: 'list', 'aria-label': 'In-browser models' }, h('div', { class: 'app-loading' }, loader(24, 'Loading models')));
  const storage = h('p', { class: 'muted st-note' });
  const status = h('p', { class: 'st-note', 'aria-live': 'polite' });
  let showAll = false;
  let entries: ModelEntry[] = [];
  let downloaded = new Set<string>();
  const busy = new Map<string, { loaded: number; total: number; ctl: AbortController }>();

  const allBtn = h('button', { class: 'btn small ghost', type: 'button', onclick: () => ((showAll = !showAll), render()) });
  const folderInput = h('input', { type: 'file', multiple: true, hidden: true });
  folderInput.setAttribute('webkitdirectory', '');
  const importBtn = h('button', { class: 'btn', type: 'button', onclick: () => folderInput.click() }, 'Import from a folder…');
  const unloadBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => unload() }, 'Free GPU memory');

  const loadedProc = () => os.procs.list().find((p) => p.name === 'webllm');
  function unload(): void {
    const p = loadedProc();
    if (p) os.procs.kill(p.pid, 'unloaded from Settings');
    syncUnload();
  }
  const syncUnload = () => {
    const p = loadedProc();
    unloadBtn.hidden = !p;
    unloadBtn.title = p ? `${p.detail ?? 'A model'} is in GPU memory` : '';
  };
  ctx.on('proc:spawn', syncUnload);
  ctx.on('proc:exit', syncUnload);

  async function refreshStorage(): Promise<void> {
    const est = await navigator.storage?.estimate?.().catch(() => null);
    storage.textContent = est?.quota ? `This site is using ${fmtBytes(est.usage ?? 0)} of the ${fmtBytes(est.quota)} the browser allows it.` : '';
  }

  function row(m: ModelEntry): HTMLElement {
    const inUse = cfg().webllmModel === m.id;
    const have = downloaded.has(m.id);
    const job = busy.get(m.id);
    const meta = [`${(m.vramMB / 1024).toFixed(1)} GB GPU memory`, m.low ? 'fits phones' : '', m.custom ? 'imported' : '', `${m.contextWindow / 1024}k context`].filter(Boolean).join(' · ');
    const actions: HTMLElement[] = [];
    if (job) {
      const pct = job.total ? Math.floor((job.loaded / job.total) * 100) : 0;
      actions.push(
        h('span', { class: 'wl-progress' }, h('progress', { max: 100, value: pct, 'aria-label': `Downloading ${pretty(m.id)}` }), h('span', { class: 'muted' }, `${pct}% · ${fmtBytes(job.loaded)}${job.total ? ` / ${fmtBytes(job.total)}` : ''}`)),
        h('button', { class: 'btn small', type: 'button', onclick: () => job.ctl.abort() }, 'Cancel'),
      );
    } else if (have) {
      if (!inUse) actions.push(h('button', { class: 'btn small primary', type: 'button', onclick: () => use(m.id) }, 'Use'));
      actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => void del(m) }, 'Delete'));
    } else {
      actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => void get(m) }, 'Download'));
    }
    return h(
      'div',
      { class: `wl-row${inUse ? ' active' : ''}`, role: 'listitem' },
      h('div', { class: 'wl-name' }, h('strong', null, pretty(m.id)), inUse ? h('span', { class: 'badge ok' }, 'In use') : have ? h('span', { class: 'badge' }, 'On this device') : null, h('span', { class: 'muted wl-meta' }, meta)),
      h('div', { class: 'wl-actions' }, actions),
    );
  }

  function render(): void {
    const shown = entries.filter((m) => showAll || m.recommended || downloaded.has(m.id) || cfg().webllmModel === m.id);
    list.replaceChildren(...shown.map(row));
    allBtn.textContent = showAll ? 'Show recommended only' : `Show all ${entries.length} models`;
  }

  function use(id: string): void {
    save({ webllmModel: id, provider: 'webllm' });
    status.className = 'st-note st-ok';
    status.textContent = `${pretty(id)} will load on your next message.`;
    render();
  }

  async function get(m: ModelEntry): Promise<void> {
    const ctl = new AbortController();
    const job = { loaded: 0, total: 0, ctl };
    busy.set(m.id, job);
    render();
    let last = 0;
    try {
      await download(os.settings, m.id, (loaded, total) => {
        job.loaded = loaded;
        job.total = total;
        if (performance.now() - last > 250) {
          last = performance.now();
          render();
        }
      }, ctl.signal);
      downloaded.add(m.id);
      status.className = 'st-note st-ok';
      status.textContent = `${pretty(m.id)} is on this device and works offline.`;
    } catch (err) {
      status.className = 'st-note st-error';
      status.textContent = ctl.signal.aborted ? 'Download cancelled. What was downloaded is kept; Download continues from there.' : `Could not download ${pretty(m.id)}: ${errText(err)}`;
    } finally {
      busy.delete(m.id);
      render();
      void refreshStorage();
    }
  }

  async function del(m: ModelEntry): Promise<void> {
    if (!(await confirmDialog(`Delete ${pretty(m.id)}?`, m.custom ? 'The imported model is removed from this browser. The folder on your computer is not touched.' : 'Its files are removed from this browser; you can download it again later.', 'Delete', true))) return;
    if (cfg().webllmModel === m.id) unload();
    await remove(os.settings, m.id);
    downloaded.delete(m.id);
    if (m.custom) entries = entries.filter((e) => e.id !== m.id);
    render();
    void refreshStorage();
  }

  folderInput.addEventListener('change', async () => {
    const files = [...(folderInput.files ?? [])];
    folderInput.value = '';
    if (!files.length) return;
    status.className = 'st-note muted';
    status.textContent = 'Importing…';
    try {
      const id = await importFolder(os.settings, files, (loaded, total) => (status.textContent = `Importing… ${Math.floor((loaded / total) * 100)}%`));
      await load();
      use(id);
      status.textContent = `Imported ${pretty(id)}. It will load on your next message.`;
    } catch (err) {
      status.className = 'st-note st-error';
      status.textContent = errText(err);
    }
  });

  async function load(): Promise<void> {
    try {
      entries = await catalogue(os.settings);
      downloaded = await downloadedIds(os.settings, entries.map((e) => e.id));
      render();
    } catch (err) {
      list.replaceChildren(h('p', { class: 'st-note st-error' }, `Could not list models: ${errText(err)}`));
    }
  }
  void load();
  void refreshStorage();
  syncUnload();

  return h(
    'div',
    { class: 'wl' },
    gpuOk ? null : h('p', { class: 'st-callout' }, h('span', { class: 'badge warn' }, 'WebGPU unavailable'), ' This browser cannot run in-browser models. You can still download them here for a browser that can (Chrome, Edge, or Safari with WebGPU).'),
    list,
    h('div', { class: 'row st-wrap' }, allBtn, importBtn, unloadBtn),
    status,
    storage,
    h('p', { class: 'muted st-note' }, 'Weights download once and then work offline. A model needs about as much GPU memory as shown; small models follow complex instructions less reliably. "Import from a folder" takes an MLC-compiled model: its mlc-chat-config.json, tensor-cache.json and shards, tokenizer, and the WebGPU .wasm library.'),
    folderInput,
  );
}
