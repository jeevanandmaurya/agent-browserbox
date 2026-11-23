import type { ProcKind } from '@jeevanand/agent-browserbox-runtime/client';
import type { AppContext } from '@/ui/apps';
import { fmtBytes, h } from '@/ui/dom';
import { createChart, type Chart } from './chart';

const HISTORY = 60;
const LAG_INTERVAL = 100;
const KINDS: Array<{ kind: ProcKind; color: string }> = [
  { kind: 'app', color: '--accent' },
  { kind: 'agent', color: '--warn' },
  { kind: 'shell', color: '--ok' },
  { kind: 'sandbox', color: '--err' },
  { kind: 'service', color: '--muted' },
];

interface HeapInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}
interface NetInfo extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

/**
 * Estimates main-thread busyness: a 100 ms timer that fires late means the
 * thread was busy for roughly that long. Long-task entries (Chromium) give a
 * second, more direct reading; we report whichever is higher.
 */
class LoadMeter {
  #timer = 0;
  #expected = 0;
  #lag = 0;
  #long = 0;
  #since = 0;
  #obs: PerformanceObserver | null = null;
  readonly longTasksSupported = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask');

  start(): void {
    if (this.#timer) return;
    this.#since = performance.now();
    this.#lag = this.#long = 0;
    const tick = () => {
      const now = performance.now();
      // ~2 ms of slack absorbs normal timer jitter so an idle page reads ~0%.
      this.#lag += Math.max(0, now - this.#expected - 2);
      this.#expected = now + LAG_INTERVAL;
      this.#timer = window.setTimeout(tick, LAG_INTERVAL);
    };
    this.#expected = performance.now() + LAG_INTERVAL;
    this.#timer = window.setTimeout(tick, LAG_INTERVAL);
    if (this.longTasksSupported) {
      try {
        this.#obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) this.#long += e.duration;
        });
        this.#obs.observe({ type: 'longtask' });
      } catch {
        this.#obs = null;
      }
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = 0;
    this.#obs?.disconnect();
    this.#obs = null;
  }

  /** Busy percentage since the previous call. */
  take(): number {
    const now = performance.now();
    const elapsed = Math.max(1, now - this.#since);
    const busy = Math.max(this.#lag, this.#long) / elapsed;
    this.#since = now;
    this.#lag = this.#long = 0;
    return Math.min(100, Math.max(0, busy * 100));
  }
}

function card(title: string, chart: Chart, value: HTMLElement, extra?: HTMLElement): HTMLElement {
  return h('section', { class: 'card tm-card' }, h('div', { class: 'tm-card-head' }, h('h3', null, title), value), chart.el, extra);
}

function fact(label: string, value: string): HTMLElement {
  return h('div', { class: 'tm-fact' }, h('span', { class: 'muted' }, label), h('strong', null, value));
}

export function perfTab(ctx: AppContext): { el: HTMLElement; setActive(on: boolean): void } {
  const { os } = ctx;
  let tabActive = false;
  const meter = new LoadMeter();
  const heap = (): HeapInfo | undefined => (performance as unknown as { memory?: HeapInfo }).memory;

  const cpuChart = createChart({ label: 'Main-thread load, last 60 seconds', capacity: HISTORY, max: 100, area: true, series: [{ label: 'busy', color: '--accent' }] });
  const heapChart = createChart({ label: 'JavaScript heap used, last 60 seconds', capacity: HISTORY, area: true, series: [{ label: 'heap', color: '--ok' }] });
  const storeChart = createChart({ label: 'Storage used, last 60 seconds', capacity: HISTORY, area: true, series: [{ label: 'storage', color: '--warn' }] });
  const procChart = createChart({ label: 'Process count by kind, last 60 seconds', capacity: HISTORY, series: KINDS.map((k) => ({ label: k.kind, color: k.color })) });

  const cpuVal = h('span', { class: 'tm-val' }, '—');
  const heapVal = h('span', { class: 'tm-val' }, heap() ? '—' : 'not exposed by this browser');
  const storeVal = h('span', { class: 'tm-val' }, '—');
  const procVal = h('span', { class: 'tm-val' }, '—');
  const legendCounts = new Map<ProcKind, HTMLElement>();
  const legend = h(
    'ul',
    { class: 'tm-legend' },
    KINDS.map((k) => {
      const n = h('strong', null, '0');
      legendCounts.set(k.kind, n);
      return h('li', null, h('i', { style: `background: var(${k.color})`, 'aria-hidden': 'true' }), `${k.kind} `, n);
    }),
  );
  const cpuNote = h(
    'p',
    { class: 'muted tm-note' },
    meter.longTasksSupported ? 'From event-loop lag and long-task timing.' : 'Estimated from event-loop lag (long-task timing is not available in this browser).',
  );

  const nav = navigator as Navigator & { deviceMemory?: number; connection?: NetInfo };
  const netFact = h('div', { class: 'tm-fact' });
  const renderNet = () => {
    const c = nav.connection;
    const parts = c ? [c.effectiveType, c.downlink !== undefined ? `${c.downlink} Mb/s` : '', c.rtt !== undefined ? `${c.rtt} ms RTT` : '', c.saveData ? 'data saver' : ''].filter(Boolean) : [];
    netFact.replaceChildren(h('span', { class: 'muted' }, 'Network'), h('strong', null, !navigator.onLine ? 'offline' : parts.length ? parts.join(' · ') : 'not exposed by this browser'));
  };
  renderNet();
  const sig = { signal: ctx.proc.signal };
  nav.connection?.addEventListener('change', renderNet, sig);
  addEventListener('online', renderNet, sig);
  addEventListener('offline', renderNet, sig);

  const facts = h(
    'div',
    { class: 'tm-facts' },
    fact('Logical cores', String(navigator.hardwareConcurrency || 'unknown')),
    fact('Device memory', nav.deviceMemory ? `${nav.deviceMemory} GB or more` : 'not exposed by this browser'),
    netFact,
  );

  let estimating = false;
  let lastStorage: number | null = null;
  async function sampleStorage(): Promise<void> {
    if (estimating || !navigator.storage?.estimate) {
      if (!navigator.storage?.estimate) storeVal.textContent = 'not exposed by this browser';
      return;
    }
    estimating = true;
    try {
      const est = await navigator.storage.estimate();
      lastStorage = est.usage ?? 0;
      storeVal.textContent = `${fmtBytes(lastStorage)} of ${est.quota ? fmtBytes(est.quota) : '?'}`;
    } catch {
      storeVal.textContent = 'unavailable';
    } finally {
      estimating = false;
    }
  }

  function sample(): void {
    const busy = meter.take();
    cpuChart.push([busy]);
    cpuVal.textContent = `${Math.round(busy)}%`;

    const mem = heap();
    if (mem) {
      heapChart.push([mem.usedJSHeapSize]);
      heapVal.textContent = `${fmtBytes(mem.usedJSHeapSize)} of ${fmtBytes(mem.jsHeapSizeLimit)}`;
    }

    void sampleStorage();
    if (lastStorage !== null) storeChart.push([lastStorage]);

    const list = os.procs.list();
    const counts = KINDS.map((k) => list.filter((p) => p.kind === k.kind).length);
    procChart.push(counts);
    procVal.textContent = `${list.length} total`;
    KINDS.forEach((k, i) => (legendCounts.get(k.kind)!.textContent = String(counts[i])));
  }

  let running = false;
  const isActive = () => tabActive && !document.hidden && !ctx.win.minimized && !ctx.win.closed;
  const sync = () => {
    const want = isActive();
    if (want === running) return;
    running = want;
    if (want) meter.start();
    else meter.stop();
  };
  const timer = setInterval(() => {
    sync();
    if (running) sample();
  }, 1000);
  document.addEventListener('visibilitychange', sync, sig);
  ctx.proc.signal.addEventListener('abort', () => {
    clearInterval(timer);
    meter.stop();
  });

  const el = h(
    'div',
    { class: 'tm-panel tm-perf fill' },
    h(
      'div',
      { class: 'tm-grid' },
      card('Main thread', cpuChart, cpuVal, cpuNote),
      card('JavaScript heap', heapChart, heapVal, heap() ? undefined : h('p', { class: 'muted tm-note' }, 'Heap size is not exposed by this browser (Chromium only).')),
      card('Storage', storeChart, storeVal),
      card('Processes', procChart, procVal, legend),
    ),
    facts,
  );

  return {
    el,
    setActive(on) {
      tabActive = on;
      sync();
      if (on) [cpuChart, heapChart, storeChart, procChart].forEach((c) => c.draw());
    },
  };
}
