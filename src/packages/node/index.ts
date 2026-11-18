import { runInNode } from '@/shell/commands/noderun';
import type { Command } from '@/shell/shell';
import type { PackageModule } from '../types';

const node: Command = {
  name: 'node',
  summary: 'Node.js (in WebContainers): run scripts; npm and npx are real npm too while this package is installed',
  usage: 'node file.js  |  node -e "code"  |  node -v',
  run: (ctx) => runInNode(ctx, 'node', ctx.args),
};

export default { commands: [node] } satisfies PackageModule;
