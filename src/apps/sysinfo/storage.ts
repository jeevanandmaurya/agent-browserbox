import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { errText, heading, kvList } from './nav';

type Estimate = StorageEstimate & { usageDetails?: Record<string, number> };

export function storage(ctx: AppContext): HTMLElement {
  const { os } = ctx;
  const usage = h('div', { class: 'si-usage' }, h('p', { class: 'muted' }, 'Measuring…'));
  const persistedState = h('span', { class: 'badge' }, '…');
  const persistBtn = h('button', { class: 'btn small', type: 'button', onclick: () => void requestPersist() }, 'Request persistence');
  const mountsBody = h('tbody');

  async function renderUsage(): Promise<void> {
    if (!navigator.storage?.estimate) {
      usage.replaceChildren(h('p', { class: 'muted' }, 'Storage estimates are not exposed by this browser.'));
      return;
    }
    try {
      const est = (await navigator.storage.estimate()) as Estimate;
      const used = est.usage ?? 0;
      const quota = est.quota ?? 0;
      const pct = quota ? (used / quota) * 100 : 0;
      const details = Object.entries(est.usageDetails ?? {}).filter(([, v]) => v > 0);
      usage.replaceChildren(
        h('div', { class: 'si-usage-line' }, h('strong', null, fmtBytes(used)), h('span', { class: 'muted' }, quota ? ` used of ${fmtBytes(quota)} (${pct < 0.1 && used ? '<0.1' : pct.toFixed(1)}%)` : ' used')),
        h(
          'div',
          { class: 'si-meter', role: 'meter', 'aria-label': 'Storage used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct.toFixed(1) },
          h('div', { style: `width: ${Math.max(pct, used ? 0.5 : 0)}%` }),
        ),
        details.length
          ? h(
              'ul',
              { class: 'si-breakdown' },
              details.sort((a, b) => b[1] - a[1]).map(([k, v]) => h('li', null, h('span', null, k), h('span', { class: 'mono muted' }, fmtBytes(v)))),
            )
          : '',
      );
    } catch (err) {
      usage.replaceChildren(h('p', { class: 'muted' }, `Could not read storage usage: ${errText(err)}`));
    }
  }

  async function renderPersisted(): Promise<void> {
    if (!navigator.storage?.persisted) {
      persistedState.textContent = 'not supported';
      persistBtn.hidden = true;
      return;
    }
    try {
      const yes = await navigator.storage.persisted();
      persistedState.textContent = yes ? 'persistent' : 'best effort';
      persistedState.className = `badge ${yes ? 'ok' : 'warn'}`;
      persistBtn.hidden = yes || !navigator.storage.persist;
    } catch {
      persistedState.textContent = 'unknown';
    }
  }

  async function requestPersist(): Promise<void> {
    persistBtn.disabled = true;
    try {
      const granted = await navigator.storage.persist();
      os.notify(
        granted
          ? { title: 'Storage is now persistent', level: 'ok' }
          : { title: 'Persistence not granted', body: 'The browser decides this; bookmarking or installing the app often helps.', level: 'warn' },
      );
    } catch (err) {
      os.notify({ title: 'Could not request persistence', body: errText(err), level: 'error' });
    } finally {
      persistBtn.disabled = false;
      void renderPersisted();
    }
  }

  function renderMounts(): void {
    mountsBody.replaceChildren(
      ...[...os.fs.mounts()]
        .sort((a, b) => a.point.localeCompare(b.point))
        .map((m) => {
          const native = m.fs.label.startsWith('native:');
          return h(
            'tr',
            null,
            h('td', { class: 'mono' }, m.point),
            h('td', null, m.fs.label),
            h('td', null, h('span', { class: `badge ${m.fs.readonly ? '' : 'ok'}` }, m.fs.readonly ? 'ro' : 'rw')),
            h(
              'td',
              null,
              native ? h('button', { class: 'btn small', type: 'button', 'aria-label': `Unmount ${m.point}`, onclick: () => os.fs.unmount(m.point) }, 'Unmount') : null,
            ),
          );
        }),
    );
  }

  const mountBtn = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      hidden: !os.hasCap('fsaccess'),
      onclick: async () => {
        try {
          const point = await os.mountNativeFolder();
          os.notify({ title: `Mounted at ${point}`, level: 'ok' });
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') os.notify({ title: 'Could not mount folder', body: errText(err), level: 'error' });
        }
      },
    },
    'Mount local folder…',
  );

  ctx.on('fs:change', (c) => {
    if (c.type === 'mount') renderMounts();
  });
  void renderUsage();
  void renderPersisted();
  renderMounts();

  return h(
    'div',
    { class: 'si-section' },
    heading('Storage', os.rootKind === 'opfs' ? 'Files live in this browser’s Origin Private File System.' : 'The root filesystem is in memory; files are lost when this tab closes.'),
    h('div', { class: 'card col' }, usage, h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => void renderUsage() }, 'Refresh'))),
    kvList([['Eviction protection', h('span', { class: 'row si-inline' }, persistedState, persistBtn)]]),
    h('div', { class: 'row si-subhead' }, h('h3', null, 'Mounts'), h('span', { class: 'spacer' }), mountBtn),
    h(
      'div',
      { class: 'si-table-wrap' },
      h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Mount point'), h('th', null, 'Filesystem'), h('th', null, 'Access'), h('th', null, h('span', { class: 'si-sr' }, 'Actions')))), mountsBody),
    ),
    os.hasCap('fsaccess') ? null : h('p', { class: 'muted' }, 'Mounting real folders needs the File System Access API (Chromium-based desktop browsers).'),
  );
}
