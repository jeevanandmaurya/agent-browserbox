import type { AppContext } from '@/ui/apps';
import { fmtDuration, h } from '@/ui/dom';
import { heading, kvList } from './nav';

interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
}

export function overview(ctx: AppContext): HTMLElement {
  const { os } = ctx;
  const sig = { signal: ctx.proc.signal };
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string; mobile?: boolean };
    getBattery?: () => Promise<BatteryLike>;
  };

  const uptime = h('span', { class: 'mono' });
  const tick = () => (uptime.textContent = fmtDuration(performance.now() - os.bootStart));
  tick();
  const timer = setInterval(() => !document.hidden && tick(), 1000);
  ctx.proc.signal.addEventListener('abort', () => clearInterval(timer));

  const online = h('span', { class: 'badge' });
  const renderOnline = () => {
    online.textContent = navigator.onLine ? 'online' : 'offline';
    online.className = `badge ${navigator.onLine ? 'ok' : 'warn'}`;
  };
  renderOnline();
  addEventListener('online', renderOnline, sig);
  addEventListener('offline', renderOnline, sig);

  const screenInfo = h('span');
  const renderScreen = () => {
    screenInfo.textContent = `${screen.width} × ${screen.height} @ ${Math.round(devicePixelRatio * 100) / 100}x (viewport ${innerWidth} × ${innerHeight})`;
  };
  renderScreen();
  addEventListener('resize', renderScreen, sig);

  const battery = h('span', { class: 'muted' }, nav.getBattery ? 'reading…' : 'not exposed by this browser');
  if (nav.getBattery) {
    nav
      .getBattery()
      .then((b) => {
        const render = () => {
          const pct = Math.round(b.level * 100);
          const eta = b.charging ? b.chargingTime : b.dischargingTime;
          const etaText = Number.isFinite(eta) && eta > 0 ? ` · ${fmtDuration(eta * 1000)} ${b.charging ? 'to full' : 'left'}` : '';
          battery.className = '';
          battery.textContent = `${pct}% ${b.charging ? '(charging)' : '(on battery)'}${etaText}`;
        };
        render();
        for (const ev of ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange']) b.addEventListener(ev, render, sig);
      })
      .catch(() => (battery.textContent = 'unavailable'));
  }

  const root =
    os.rootKind === 'opfs'
      ? h('span', null, h('span', { class: 'badge ok' }, 'persistent'), ' Origin Private File System')
      : h('span', null, h('span', { class: 'badge warn' }, 'in memory'), ' Files are lost when this tab closes');

  const isolated = globalThis.crossOriginIsolated
    ? h('span', { class: 'badge ok' }, 'isolated')
    : h('span', null, h('span', { class: 'badge' }, 'not isolated'), h('span', { class: 'muted' }, ' SharedArrayBuffer and threads are unavailable'));

  const langs = navigator.languages?.length ? navigator.languages.join(', ') : navigator.language;
  const platform = nav.userAgentData?.platform || navigator.platform || 'unknown';

  return h(
    'div',
    { class: 'si-section' },
    heading('Overview', `BrowserBox ${os.version}`),
    kvList([
      ['Version', `BrowserBox ${os.version}`],
      ['Uptime', uptime],
      ['Root filesystem', root],
      ['Network', online],
      ['Platform', `${platform}${nav.userAgentData?.mobile ? ' (mobile)' : ''}`],
      ['Language', langs],
      ['Logical cores', String(navigator.hardwareConcurrency || 'unknown')],
      ['Device memory', nav.deviceMemory ? `${nav.deviceMemory} GB or more` : 'not exposed by this browser'],
      ['Screen', screenInfo],
      ['Battery', battery],
      ['Cross-origin isolation', isolated],
      ['User agent', h('span', { class: 'mono si-wrap' }, navigator.userAgent)],
    ]),
  );
}

export function capabilities(ctx: AppContext): HTMLElement {
  const caps = ctx.os.caps;
  const ok = caps.filter((c) => c.ok).length;
  const groups = [...new Set(caps.map((c) => c.group))];
  const body = h('div', { class: 'si-caps' });
  const empty = h('p', { class: 'muted', hidden: true }, 'No capabilities match.');
  const filter = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter capabilities',
    'aria-label': 'Filter capabilities',
    oninput: () => render(filter.value.trim().toLowerCase()),
  });

  function render(q: string): void {
    let shown = 0;
    body.replaceChildren(
      ...groups.map((g) => {
        const items = caps.filter((c) => c.group === g && (!q || `${c.id} ${c.label} ${c.use} ${c.group}`.toLowerCase().includes(q)));
        shown += items.length;
        if (!items.length) return '';
        const have = items.filter((c) => c.ok).length;
        return h(
          'section',
          { class: 'si-cap-group' },
          h('h3', null, g, h('span', { class: 'muted' }, ` ${have}/${items.length}`)),
          h(
            'ul',
            { class: 'si-cap-list' },
            items.map((c) =>
              h(
                'li',
                { class: c.ok ? '' : 'missing' },
                h('span', { class: `badge ${c.ok ? 'ok' : 'err'}`, 'aria-label': c.ok ? 'available' : 'unavailable', title: c.ok ? 'available' : 'unavailable' }, c.ok ? '✓' : '✗'),
                h('span', { class: 'si-cap-label' }, c.label),
                h('span', { class: 'muted si-cap-use' }, c.use),
              ),
            ),
          ),
        );
      }),
    );
    empty.hidden = shown > 0;
  }
  render('');

  return h(
    'div',
    { class: 'si-section' },
    heading('Capabilities', `${ok} of ${caps.length} platform features available in this browser`),
    h('div', { class: 'si-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(caps.length), 'aria-valuenow': String(ok), 'aria-label': 'Available capabilities' }, h('div', { style: `width: ${(ok / Math.max(1, caps.length)) * 100}%` })),
    filter,
    empty,
    body,
  );
}
