import { DOCS_URL } from '@/app/config';
import type { AppModule } from '@/ui/apps';
import { docsView } from './view';

/** The documentation, inside BrowserBox (the same as the /docs/ page). */
const app: AppModule = {
  mount(ctx) {
    const topic = typeof ctx.args.topic === 'string' ? ctx.args.topic : undefined;
    const view = docsView({
      initial: topic,
      pageUrl: DOCS_URL + (topic ? `#${topic}` : ''),
      footer: `BrowserBox ${ctx.os.version}`,
      onNavigate: () => ctx.win.setTitle('Help'),
    });
    ctx.root.append(view);
  },
};

export default app;
