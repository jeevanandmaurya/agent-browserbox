import type { AppModule } from '@/ui/apps';
import { h } from '@/ui/dom';
import { dataSection } from './data';
import { modelSection } from './model';
import { sectionNav } from './nav';
import { appearanceSection, permissionsSection } from './permissions';
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

    const nav = sectionNav(
      [
        { id: 'model', label: 'Model', build: () => modelSection(ctx, saved) },
        { id: 'permissions', label: 'Permissions', build: () => permissionsSection(ctx, saved) },
        { id: 'appearance', label: 'Appearance', build: () => appearanceSection(ctx, saved) },
        { id: 'data', label: 'Data', build: () => dataSection(ctx, () => nav.invalidate()) },
      ],
      'Settings sections',
      ctx.proc.pid,
    );
    ctx.root.append(nav.el, pill);
    nav.show(typeof ctx.args.section === 'string' ? ctx.args.section : 'model');
    return () => clearTimeout(hideTimer);
  },
};
export default app;
