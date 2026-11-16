import type { AppModule } from '@/ui/apps';
import { boot } from './boot';
import { gpu } from './gpu';
import { sectionNav } from './nav';
import { capabilities, overview } from './overview';
import { storage } from './storage';
import './style.css';

const app: AppModule = {
  mount(ctx) {
    const nav = sectionNav(
      [
        { id: 'overview', label: 'Overview', build: () => overview(ctx) },
        { id: 'caps', label: 'Capabilities', build: () => capabilities(ctx) },
        { id: 'storage', label: 'Storage', build: () => storage(ctx) },
        { id: 'gpu', label: 'GPU', build: () => gpu(ctx) },
        { id: 'boot', label: 'Boot', build: () => boot(ctx) },
      ],
      'System sections',
      ctx.proc.pid,
    );
    ctx.root.append(nav.el);
    nav.show(typeof ctx.args.section === 'string' ? ctx.args.section : 'overview');
  },
};
export default app;
