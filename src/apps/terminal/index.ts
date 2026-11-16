import type { AppModule } from '@/ui/apps';

const app: AppModule = {
  mount(ctx) {
    ctx.root.textContent = 'terminal';
  },
};
export default app;
