import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { heading, kvList } from './nav';

const ms = (v: number) => `${Math.round(v)} ms`;

export function boot(ctx: AppContext): HTMLElement {
  const marks = [...ctx.os.bootMarks].sort((a, b) => a.at - b.at);
  const span = Math.max(1, ...marks.map((m) => m.at));

  const timeline = marks.length
    ? h(
        'ol',
        { class: 'si-timeline', 'aria-label': 'Boot milestones' },
        marks.map((m) =>
          h(
            'li',
            null,
            h('span', { class: 'si-tl-name mono' }, m.name),
            h('span', { class: 'si-tl-track', 'aria-hidden': 'true' }, h('span', { class: 'si-tl-bar', style: `width: ${(m.at / span) * 100}%` })),
            h('span', { class: 'si-tl-at mono' }, `${m.at} ms`),
          ),
        ),
      )
    : h('p', { class: 'muted' }, 'No boot milestones recorded yet.');

  const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  const navInfo = nav
    ? kvList([
        ['Navigation type', nav.type],
        ['DNS lookup', ms(nav.domainLookupEnd - nav.domainLookupStart)],
        ['Connect', ms(nav.connectEnd - nav.connectStart)],
        ['Time to first byte', ms(nav.responseStart - nav.startTime)],
        ['DOM content loaded', ms(nav.domContentLoadedEventEnd - nav.startTime)],
        ['Load event', nav.loadEventEnd ? ms(nav.loadEventEnd - nav.startTime) : 'pending'],
        ['Transferred', nav.transferSize ? fmtBytes(nav.transferSize) : 'from cache'],
      ])
    : h('p', { class: 'muted' }, 'Navigation timing is not available.');

  const sw = navigator.serviceWorker;
  const ctl = sw?.controller;
  const swInfo = !sw
    ? h('span', { class: 'muted' }, 'Service workers are not supported here')
    : ctl
      ? h('span', null, h('span', { class: 'badge ok' }, 'active'), h('span', { class: 'muted mono' }, ` ${new URL(ctl.scriptURL).pathname}`))
      : h('span', null, h('span', { class: 'badge' }, 'none'), h('span', { class: 'muted' }, ' This page loaded from the network (offline boot not active yet)'));

  return h(
    'div',
    { class: 'si-section' },
    heading('Boot', 'Milestones in ms since navigation start'),
    timeline,
    h('h3', null, 'Page load'),
    navInfo,
    h('h3', null, 'Offline'),
    kvList([['Service worker', swInfo]]),
  );
}
