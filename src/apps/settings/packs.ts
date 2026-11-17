import type { Kernel } from '@/kernel/api';
import type { PackState } from '@/kernel/packs';
import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { errText } from './nav';

function status(p: PackState): string {
  if (!p.available) return 'Planned';
  if (p.error) return `Failed: ${p.error}`;
  if (p.downloading) return p.bytes ? `Downloading ${fmtBytes(p.loaded)} of ${fmtBytes(p.bytes)}` : `Downloading ${fmtBytes(p.loaded)}`;
  if (p.selected && p.cached) return p.bytes ? `Installed · ${fmtBytes(p.bytes)} on this device` : 'Installed';
  if (p.selected) return 'On · downloads the first time it is used';
  return p.bytes ? `Not installed · ${fmtBytes(p.bytes)}` : 'Not installed';
}

/**
 * Tool packs with their real state: installed or not, size on disk, and a
 * progress bar while downloading. Install downloads now; Remove deletes the files.
 */
export function packManager(ctx: AppContext): HTMLElement {
  const { os } = ctx;
  const rows = new Map<string, HTMLElement>();
  const list = h('ul', { class: 'st-list pm-list' });

  function render(p: PackState): HTMLElement {
    const bar = p.downloading ? h('div', { class: 'st-meter pm-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.bytes || 100), 'aria-valuenow': String(p.loaded), 'aria-label': `${p.name} download` }, h('div', { style: `width:${p.bytes ? Math.min(100, (p.loaded / p.bytes) * 100) : 5}%` })) : null;
    const action = !p.available
      ? null
      : p.downloading
        ? null
        : p.selected && p.cached
          ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => void act(os, p.id, 'remove') }, 'Remove')
          : h('button', { class: 'btn small', type: 'button', onclick: () => void act(os, p.id, 'install') }, p.error ? 'Retry' : 'Install');
    const li = h(
      'li',
      { class: `pm-row ${p.available ? '' : 'soon'}`, dataset: { pack: p.id } },
      h('div', { class: 'ex-text' }, h('span', { class: 'ex-name' }, p.name), h('span', { class: 'muted ex-desc' }, p.description), h('span', { class: `pm-status ${p.error ? 'st-error' : p.selected && p.cached ? 'st-ok' : 'muted'}` }, status(p)), bar),
      action,
    );
    rows.get(p.id)?.replaceWith(li);
    rows.set(p.id, li);
    return li;
  }

  async function act(os: Kernel, id: string, what: 'install' | 'remove'): Promise<void> {
    try {
      await (what === 'install' ? os.packs.install(id) : os.packs.remove(id));
    } catch (err) {
      os.notify({ title: `Could not ${what} ${id}`, body: errText(err), level: 'error' });
    }
  }

  ctx.on('pack:change', (p) => render(p));
  void os.packs.list().then((all) => list.replaceChildren(...all.map(render)));
  return list;
}
