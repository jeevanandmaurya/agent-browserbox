import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';
import { connectorsSection } from './connectors';
import { dataSection } from './data';
import { environmentSection } from './environment';
import { extensionSection } from './extensions';
import { modelSection } from './model';
import { sectionNav } from './nav';
import { appearanceSection } from './general';
import { permissionsSection } from './permissions';
import './style.css';

const app: AppModule = {
  mount(ctx) {
    // Subtle "Saved" pill, re-triggered on every save.
    const pill = h('div', { class: 'st-saved', role: 'status', 'aria-live': 'polite' });
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const saved = () => {
      pill.textContent = 'Saved';
      pill.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        pill.classList.remove('show');
        pill.textContent = '';
      }, 1600);
    };

    const sections = [
      { id: 'model', label: 'Model', build: () => modelSection(ctx, saved) },
      { id: 'permissions', label: 'Permissions', build: () => permissionsSection(ctx, saved) },
      { id: 'appearance', label: 'Appearance', build: () => appearanceSection(ctx, saved) },
      { id: 'connectors', label: 'Connectors', build: () => connectorsSection(ctx, saved) },
      { id: 'skills', label: 'Skills', build: () => extensionSection(ctx, 'skill', saved) },
      { id: 'agents', label: 'Agents', build: () => extensionSection(ctx, 'agent', saved) },
      { id: 'commands', label: 'Commands', build: () => extensionSection(ctx, 'command', saved) },
      { id: 'environment', label: 'Environment', build: () => environmentSection(ctx, saved) },
      { id: 'data', label: 'Data', build: () => dataSection(ctx, () => nav.invalidate()) },
    ];
    // `only` embeds a single section with no nav (the agent window's first-run setup uses the Model section).
    const only = sections.find((s) => s.id === ctx.args.only);
    if (only) {
      ctx.root.append(h('div', { class: 'sn-panel st-only' }, h('div', { class: 'sn-main' }, only.build())), pill);
      return () => clearTimeout(hideTimer);
    }
    const nav = sectionNav(sections, 'Settings sections', ctx.proc.pid);
    ctx.root.append(nav.el, pill);
    // A deep link opens that section directly; otherwise phones start at the list.
    nav.show(typeof ctx.args.section === 'string' ? ctx.args.section : 'model', typeof ctx.args.section === 'string');
    return () => clearTimeout(hideTimer);
  },
};
export default app;
