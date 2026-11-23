import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';
import { perfTab } from './perf';
import { processesTab } from './processes';
import './style.css';

const app: AppModule = {
  mount(ctx) {
    const tabs = [
      { id: 'procs', label: 'Processes', view: processesTab(ctx) },
      { id: 'perf', label: 'Performance', view: perfTab(ctx) },
    ];
    const buttons = tabs.map((t, i) =>
      h('button', { class: 'tm-tab', type: 'button', role: 'tab', id: `tm-tab-${t.id}-${ctx.proc.pid}`, onclick: () => show(i) }, t.label),
    );
    const panels = tabs.map((t, i) => {
      t.view.el.setAttribute('role', 'tabpanel');
      t.view.el.setAttribute('aria-labelledby', buttons[i]!.id);
      return t.view.el;
    });
    const strip = h('div', { class: 'tm-tabs', role: 'tablist', 'aria-label': 'Task Manager views' }, buttons);
    strip.addEventListener('keydown', (e) => {
      const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (cur < 0 || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      e.preventDefault();
      const next = (cur + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      show(next);
      buttons[next]!.focus();
    });

    function show(index: number): void {
      tabs.forEach((t, i) => {
        const on = i === index;
        buttons[i]!.setAttribute('aria-selected', String(on));
        buttons[i]!.tabIndex = on ? 0 : -1;
        panels[i]!.hidden = !on;
        t.view.setActive(on);
      });
    }

    ctx.root.append(strip, ...panels);
    show(ctx.args.tab === 'performance' ? 1 : 0);
  },
};
export default app;
