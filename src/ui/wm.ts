import { h } from './dom';
import { icon, type IconName } from './icons';

export interface WindowOptions {
  title: string;
  icon?: IconName;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

const isCompact = () => innerWidth < 760;

export class WindowHandle {
  readonly el: HTMLElement;
  /** Apps render into this element. */
  readonly body: HTMLElement;
  #titleEl: HTMLElement;
  #closeFns: Array<() => void> = [];
  #restore: { left: string; top: string; width: string; height: string } | null = null;
  closed = false;
  minimized = false;
  title: string;
  readonly icon: IconName;

  constructor(
    private wm: WindowManager,
    readonly id: number,
    opts: WindowOptions,
  ) {
    this.title = opts.title;
    this.icon = opts.icon ?? 'file';
    this.#titleEl = h('span', { class: 'win-title-text' }, opts.title);
    const bar = h(
      'header',
      { class: 'win-bar', ondblclick: () => this.toggleMaximize() },
      h('span', { class: 'win-icon' }, icon(this.icon, 15)),
      this.#titleEl,
      h(
        'span',
        { class: 'win-ctl' },
        h('button', { title: 'Minimize', 'aria-label': 'Minimize', onclick: () => this.minimize() }, icon('minus', 14)),
        h('button', { title: 'Maximize', 'aria-label': 'Maximize', onclick: () => this.toggleMaximize() }, icon('square', 13)),
        h('button', { class: 'close', title: 'Close', 'aria-label': 'Close', onclick: () => this.close() }, icon('close', 14)),
      ),
    );
    this.body = h('div', { class: 'win-body' });
    this.el = h('section', { class: 'win', role: 'dialog', 'aria-label': opts.title }, bar, this.body);
    for (const edge of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) this.el.append(this.#grip(edge, opts));

    const area = wm.area.getBoundingClientRect();
    const w = Math.min(opts.width ?? 720, area.width - 16);
    const ht = Math.min(opts.height ?? 480, area.height - 16);
    const n = wm.windows().length;
    Object.assign(this.el.style, {
      width: `${w}px`,
      height: `${ht}px`,
      left: `${Math.max(8, Math.min((area.width - w) / 2 + ((n % 6) - 2) * 28, area.width - w - 8))}px`,
      top: `${Math.max(8, Math.min((area.height - ht) / 2 + ((n % 6) - 2) * 24, area.height - ht - 8))}px`,
    });
    if (isCompact()) this.el.classList.add('max');

    this.el.addEventListener('pointerdown', () => this.focus(), true);
    this.#dragBy(bar);
  }

  #dragBy(bar: HTMLElement): void {
    bar.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.win-ctl') || e.button !== 0 || this.el.classList.contains('max')) return;
      const startX = e.clientX - this.el.offsetLeft;
      const startY = e.clientY - this.el.offsetTop;
      bar.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const area = this.wm.area.getBoundingClientRect();
        this.el.style.left = `${Math.max(80 - this.el.offsetWidth, Math.min(ev.clientX - startX, area.width - 80))}px`;
        this.el.style.top = `${Math.max(0, Math.min(ev.clientY - startY, area.height - 36))}px`;
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });
  }

  #grip(edge: string, opts: WindowOptions): HTMLElement {
    const grip = h('i', { class: `win-grip g-${edge}` });
    grip.addEventListener('pointerdown', (e) => {
      if (this.el.classList.contains('max')) return;
      e.preventDefault();
      e.stopPropagation();
      this.focus();
      grip.setPointerCapture(e.pointerId);
      const r = { x: this.el.offsetLeft, y: this.el.offsetTop, w: this.el.offsetWidth, h: this.el.offsetHeight };
      const sx = e.clientX;
      const sy = e.clientY;
      const minW = opts.minWidth ?? 280;
      const minH = opts.minHeight ?? 160;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        if (edge.includes('e')) this.el.style.width = `${Math.max(minW, r.w + dx)}px`;
        if (edge.includes('s')) this.el.style.height = `${Math.max(minH, r.h + dy)}px`;
        if (edge.includes('w')) {
          const w = Math.max(minW, r.w - dx);
          this.el.style.width = `${w}px`;
          this.el.style.left = `${r.x + r.w - w}px`;
        }
        if (edge.includes('n')) {
          const ht = Math.max(minH, r.h - dy);
          this.el.style.height = `${ht}px`;
          this.el.style.top = `${Math.max(0, r.y + r.h - ht)}px`;
        }
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    return grip;
  }

  setTitle(title: string): void {
    this.title = title;
    this.#titleEl.textContent = title;
    this.el.setAttribute('aria-label', title);
    this.wm.changed();
  }

  focus(): void {
    if (this.closed) return;
    if (this.minimized) {
      this.minimized = false;
      this.el.classList.remove('min');
    }
    this.wm.raise(this);
  }

  minimize(): void {
    this.minimized = true;
    this.el.classList.add('min');
    this.wm.blur(this);
  }

  toggleMaximize(): void {
    if (isCompact()) return;
    const s = this.el.style;
    if (this.el.classList.toggle('max')) this.#restore = { left: s.left, top: s.top, width: s.width, height: s.height };
    else if (this.#restore) Object.assign(s, this.#restore);
  }

  /** Registers cleanup that runs exactly once when the window closes. */
  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.#closeFns.push(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.#closeFns.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error('[wm] close handler threw', err);
      }
    }
    this.el.remove();
    this.wm.remove(this);
  }
}

/** Stacking window manager. Pointer-captured drag/resize, no layout thrash. */
export class WindowManager {
  #wins: WindowHandle[] = [];
  #z = 10;
  #nextId = 1;
  #listeners = new Set<() => void>();
  focused: WindowHandle | null = null;

  constructor(readonly area: HTMLElement) {}

  open(opts: WindowOptions): WindowHandle {
    const win = new WindowHandle(this, this.#nextId++, opts);
    this.#wins.push(win);
    this.area.append(win.el);
    win.focus();
    return win;
  }

  windows(): readonly WindowHandle[] {
    return this.#wins;
  }

  raise(win: WindowHandle): void {
    win.el.style.zIndex = String(++this.#z);
    this.focused?.el.classList.remove('focus');
    this.focused = win;
    win.el.classList.add('focus');
    this.changed();
  }

  blur(win: WindowHandle): void {
    if (this.focused !== win) return this.changed();
    win.el.classList.remove('focus');
    this.focused = null;
    const next = this.#wins.filter((w) => !w.minimized && w !== win).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
    if (next) this.raise(next);
    else this.changed();
  }

  remove(win: WindowHandle): void {
    this.#wins = this.#wins.filter((w) => w !== win);
    this.blur(win);
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  changed(): void {
    for (const fn of this.#listeners) fn();
  }
}
