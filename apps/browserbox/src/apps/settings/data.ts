import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { fmtBytes, h } from '@/ui/dom';
import { errText, heading } from './nav';

export function dataSection(ctx: AppContext, onReset: () => void): HTMLElement {
  const { os } = ctx;

  const usage = h('p', { class: 'muted' }, 'Measuring…');
  const meterFill = h('div');
  const meter = h('div', { class: 'st-meter', role: 'meter', 'aria-label': 'Storage used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, meterFill);
  async function renderUsage(): Promise<void> {
    if (!navigator.storage?.estimate) {
      usage.textContent = 'This browser does not report storage usage.';
      meter.hidden = true;
      return;
    }
    try {
      const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
      const pct = quota ? (used / quota) * 100 : 0;
      usage.textContent = `${fmtBytes(used)} used${quota ? ` of ${fmtBytes(quota)} available to this site` : ''}`;
      meterFill.style.width = `${Math.max(pct, used ? 0.5 : 0)}%`;
      meter.setAttribute('aria-valuenow', pct.toFixed(1));
    } catch (err) {
      usage.textContent = `Could not read storage usage: ${errText(err)}`;
    }
  }
  void renderUsage();

  function exportSettings(): void {
    const data: Record<string, unknown> = {};
    for (const k of os.settings.keys().sort()) data[k] = os.settings.get(k, null);
    const blob = new Blob([JSON.stringify({ browserbox: os.version, exported: new Date().toISOString(), settings: data }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `browserbox-settings-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function resetSettings(): Promise<void> {
    const ok = await confirmDialog(
      'Reset all settings?',
      'This restores defaults for the model choice, permissions, theme and every app preference. Saved API keys and your files are kept.',
      'Reset settings',
      true,
    );
    if (!ok) return;
    for (const k of os.settings.keys()) os.settings.delete(k);
    os.notify({ title: 'Settings reset to defaults', level: 'ok' });
    onReset();
  }

  const eraseStatus = h('div', { class: 'st-erase-status', 'aria-live': 'polite' });
  const eraseBtn = h('button', { class: 'btn danger', type: 'button', onclick: () => void eraseFiles() }, 'Erase all files…');

  async function eraseFiles(): Promise<void> {
    const ok = await confirmDialog(
      'Erase all files?',
      'Every file and folder in BrowserBox (your documents, the agent’s workspace and memory) will be permanently deleted. Mounted local folders are not touched. This cannot be undone.',
      'Erase everything',
      true,
    );
    if (!ok) return;
    eraseBtn.disabled = true;
    eraseStatus.replaceChildren(h('p', { class: 'muted' }, 'Erasing…'));
    const points = os.fs.mounts().map((m) => m.point);
    const isMount = (p: string) => points.includes(p);
    const containsMount = (p: string) => points.some((m) => m.startsWith(`${p}/`));
    const failed: string[] = [];
    // Walk down only into folders that contain a mount point, so mounted folders survive.
    const erase = async (dir: string): Promise<void> => {
      for (const e of await os.fs.readdir(dir)) {
        if (isMount(e.path)) continue;
        try {
          if (e.kind === 'dir' && containsMount(e.path)) await erase(e.path);
          else await os.fs.rm(e.path, { recursive: true });
        } catch (err) {
          failed.push(`${e.path}: ${errText(err)}`);
        }
      }
    };
    try {
      await erase('/');
    } catch (err) {
      failed.push(errText(err));
    }
    eraseBtn.disabled = false;
    void renderUsage();
    const reload = h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Reload now');
    eraseStatus.replaceChildren(
      failed.length
        ? h('div', { class: 'col' }, h('p', { class: 'st-error' }, `Some items could not be erased (${failed.length}):`), h('pre', { class: 'st-pre' }, failed.slice(0, 20).join('\n')))
        : h('p', { class: 'st-ok' }, 'All files erased.'),
      h('div', { class: 'row st-wrap' }, h('span', { class: 'muted' }, 'Reload BrowserBox to recreate the default folders.'), reload),
    );
    os.notify({ title: failed.length ? 'Erase finished with errors' : 'All files erased', body: 'Reload to start fresh.', level: failed.length ? 'warn' : 'ok' });
  }

  return h(
    'div',
    { class: 'st-section' },
    heading('Data'),
    h('div', { class: 'card col' }, h('strong', null, 'Storage'), usage, meter),
    h('h3', null, 'Backup'),
    h(
      'div',
      { class: 'row st-wrap' },
      h('button', { class: 'btn', type: 'button', onclick: exportSettings }, 'Export settings'),
      h('span', { class: 'muted st-note' }, 'Downloads your preferences as JSON. API keys are never included.'),
    ),
    h(
      'section',
      { class: 'st-danger', 'aria-labelledby': 'st-danger-title' },
      h('h3', { id: 'st-danger-title' }, 'Danger zone'),
      h(
        'div',
        { class: 'st-danger-row' },
        h('div', null, h('strong', null, 'Reset settings'), h('p', { class: 'muted st-note' }, 'Restore every preference to its default. Keys and files stay.')),
        h('button', { class: 'btn danger', type: 'button', onclick: () => void resetSettings() }, 'Reset settings…'),
      ),
      h(
        'div',
        { class: 'st-danger-row' },
        h('div', null, h('strong', null, 'Erase all files'), h('p', { class: 'muted st-note' }, 'Delete everything in the BrowserBox filesystem.')),
        eraseBtn,
      ),
      eraseStatus,
    ),
  );
}
