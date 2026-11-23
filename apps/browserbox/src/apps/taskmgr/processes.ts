import type { Proc } from '@jeevanand/agent-browserbox-runtime/client';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { fmtBytes, fmtDuration, h } from '@/ui/dom';

type Key = 'pid' | 'name' | 'kind' | 'state' | 'cpu' | 'mem' | 'uptime' | 'detail';

const COLS: Array<{ key: Key; label: string; num?: boolean }> = [
  { key: 'pid', label: 'PID', num: true },
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind' },
  { key: 'state', label: 'State' },
  { key: 'cpu', label: 'CPU time', num: true },
  { key: 'mem', label: 'Memory', num: true },
  { key: 'uptime', label: 'Uptime', num: true },
  { key: 'detail', label: 'Detail' },
];

const STATE_BADGE: Record<string, string> = { running: 'ok', idle: 'muted', blocked: 'warn' };

function sortValue(p: Proc, key: Key, now: number): string | number {
  switch (key) {
    case 'cpu':
      return p.cpuMs;
    case 'mem':
      return p.memBytes;
    case 'uptime':
      return now - p.started;
    case 'pid':
      return p.pid;
    default:
      return String(p[key]).toLowerCase();
  }
}

interface Row {
  tr: HTMLTableRowElement;
  cells: HTMLTableCellElement[];
  kind: HTMLSpanElement;
  state: HTMLSpanElement;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function processesTab(ctx: AppContext): { el: HTMLElement; setActive(on: boolean): void } {
  const { os } = ctx;
  let sortKey: Key = 'pid';
  let sortDir = 1;
  let filter = '';
  let selected: number | null = null;
  let active = true;
  const rows = new Map<number, Row>();

  const tbody = h('tbody');
  const headCells = COLS.map((c) => {
    const btn = h('button', { class: 'tm-sort', type: 'button', onclick: () => setSort(c.key) }, c.label);
    return h('th', { class: c.num ? 'num' : '', scope: 'col' }, btn);
  });
  const table = h('table', { class: 'table tm-procs', 'aria-label': 'Processes' }, h('thead', null, h('tr', null, headCells)), tbody);
  const scroller = h('div', { class: 'tm-scroll fill', tabindex: -1 }, table);
  const count = h('span', { class: 'muted', 'aria-live': 'polite' });
  const endBtn = h('button', { class: 'btn danger small', type: 'button', disabled: true, onclick: () => void endTask() }, 'End task');
  const filterInput = h('input', {
    class: 'input tm-filter',
    type: 'search',
    placeholder: 'Filter processes',
    'aria-label': 'Filter processes',
    oninput: () => {
      filter = filterInput.value.trim().toLowerCase();
      render();
    },
  });

  function setSort(key: Key): void {
    sortDir = key === sortKey ? -sortDir : COLS.find((c) => c.key === key)?.num && key !== 'pid' ? -1 : 1;
    sortKey = key;
    render();
  }

  /** Orders processes as a tree (children under their parent, siblings sorted), or flat while filtering. */
  function ordered(now: number): Array<{ p: Proc; depth: number }> {
    const all = os.procs.list();
    const cmp = (a: Proc, b: Proc) => {
      const x = sortValue(a, sortKey, now);
      const y = sortValue(b, sortKey, now);
      return (x < y ? -1 : x > y ? 1 : a.pid - b.pid) * sortDir;
    };
    if (filter) {
      return all
        .filter((p) => `${p.pid} ${p.name} ${p.kind} ${p.state} ${p.detail}`.toLowerCase().includes(filter))
        .sort(cmp)
        .map((p) => ({ p, depth: 0 }));
    }
    const pids = new Set(all.map((p) => p.pid));
    const kids = new Map<number, Proc[]>();
    for (const p of all) {
      const parent = pids.has(p.ppid) && p.ppid !== p.pid ? p.ppid : 0;
      (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(p);
    }
    const out: Array<{ p: Proc; depth: number }> = [];
    const visit = (parent: number, depth: number) => {
      for (const p of (kids.get(parent) ?? []).sort(cmp)) {
        out.push({ p, depth });
        if (depth < 32) visit(p.pid, depth + 1);
      }
    };
    visit(0, 0);
    return out;
  }

  function makeRow(p: Proc): Row {
    const kind = h('span', { class: 'badge' });
    const state = h('span', { class: 'badge' });
    const cells = COLS.map((c) => h('td', { class: c.num ? 'num' : c.key === 'detail' ? 'tm-detail' : '' }));
    cells[2]!.append(kind);
    cells[3]!.append(state);
    const tr = h('tr', { tabindex: -1, dataset: { pid: String(p.pid) } }, cells);
    tr.addEventListener('click', () => select(p.pid, true));
    return { tr, cells, kind, state };
  }

  function render(): void {
    const now = Date.now();
    const list = ordered(now);
    const seen = new Set<number>();
    let prev: Element | null = null;
    for (const { p, depth } of list) {
      seen.add(p.pid);
      let row = rows.get(p.pid);
      if (!row) rows.set(p.pid, (row = makeRow(p)));
      const [pid, name, , , cpu, mem, up, detail] = row.cells;
      setText(pid!, String(p.pid));
      setText(name!, p.name);
      name!.style.paddingLeft = `${10 + depth * 16}px`;
      name!.classList.toggle('tm-child', depth > 0);
      setText(row.kind, p.kind);
      setText(row.state, p.state);
      const sb = STATE_BADGE[p.state] ?? '';
      if (row.state.className !== `badge ${sb}`.trim()) row.state.className = `badge ${sb}`.trim();
      setText(cpu!, fmtDuration(p.cpuMs));
      setText(mem!, p.memBytes ? fmtBytes(p.memBytes) : '—');
      setText(up!, fmtDuration(now - p.started));
      setText(detail!, p.detail);
      detail!.title = p.detail;
      row.tr.classList.toggle('selected', p.pid === selected);
      row.tr.setAttribute('aria-selected', String(p.pid === selected));
      // Only move nodes that are out of place, so focus and scroll stay put.
      const want: Element | null = prev ? prev.nextElementSibling : tbody.firstElementChild;
      if (want !== row.tr) tbody.insertBefore(row.tr, want);
      prev = row.tr;
    }
    for (const [pid, row] of rows) {
      if (!seen.has(pid)) {
        row.tr.remove();
        rows.delete(pid);
      }
    }
    if (selected !== null && !seen.has(selected)) selected = null;
    endBtn.disabled = selected === null;
    setText(count, filter ? `${list.length} of ${os.procs.list().length} processes` : `${list.length} processes`);
    headCells.forEach((th, i) => {
      const c = COLS[i]!;
      th.setAttribute('aria-sort', c.key === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
      th.classList.toggle('sorted', c.key === sortKey);
      th.dataset.dir = sortDir > 0 ? 'asc' : 'desc';
    });
  }

  function select(pid: number | null, focus = false): void {
    selected = pid;
    for (const [id, row] of rows) {
      row.tr.classList.toggle('selected', id === pid);
      row.tr.setAttribute('aria-selected', String(id === pid));
      row.tr.tabIndex = id === pid ? 0 : -1;
    }
    endBtn.disabled = pid === null;
    if (pid !== null && focus) rows.get(pid)?.tr.focus({ preventScroll: false });
  }

  async function endTask(): Promise<void> {
    if (selected === null) return;
    const p = os.procs.get(selected);
    if (!p) return render();
    const kids = os.procs.list().filter((c) => c.ppid === p.pid).length;
    if (p.kind === 'service' || p.pid === ctx.proc.pid) {
      const msg =
        p.pid === ctx.proc.pid
          ? 'This is the Task Manager itself; its window will close.'
          : `"${p.name}" is a system service. Ending it may break parts of BrowserBox until you reload.${kids ? ` Its ${kids} child process(es) will also end.` : ''}`;
      if (!(await confirmDialog(`End ${p.name}?`, msg, 'End task', true))) return;
    }
    if (!os.procs.kill(p.pid)) os.notify({ title: `Process ${p.pid} already exited`, level: 'info' });
  }

  scroller.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const trs = [...tbody.rows];
    const i = trs.findIndex((r) => Number(r.dataset.pid) === selected);
    const move = (to: number) => {
      const r = trs[Math.max(0, Math.min(trs.length - 1, to))];
      if (r) select(Number(r.dataset.pid), true);
      e.preventDefault();
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(trs.length - 1);
    else if (e.key === 'Delete' && selected !== null) {
      e.preventDefault();
      void endTask();
    }
  });
  // Make the table reachable with Tab even when nothing is selected yet.
  scroller.addEventListener('focus', () => {
    if (selected === null && tbody.rows[0]) select(Number(tbody.rows[0].dataset.pid), true);
  });
  scroller.tabIndex = 0;

  let raf = 0;
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), active && render()));
  };
  ctx.on('proc:spawn', schedule);
  ctx.on('proc:exit', schedule);
  ctx.on('proc:update', schedule);
  const tick = setInterval(() => active && !document.hidden && !ctx.win.minimized && render(), 1000);
  ctx.proc.signal.addEventListener('abort', () => {
    clearInterval(tick);
    cancelAnimationFrame(raf);
  });

  render();
  const el = h(
    'div',
    { class: 'tm-panel col' },
    h('div', { class: 'toolbar' }, filterInput, h('span', { class: 'spacer' }), count, endBtn),
    scroller,
    h('div', { class: 'statusbar' }, 'Select a process and press Delete to end it. Click a column header to sort.'),
  );
  return {
    el,
    setActive(on) {
      active = on;
      if (on) render();
    },
  };
}
