import { lazyCommand } from './lazy';

export const serveCommand = lazyCommand('serve', 'dev server for a project folder: bundles TS/JSX, reloads on save, runs server.ts', 'serve [dir] [--port N] [--net] [--no-open]  |  serve list  |  serve logs [port]  |  serve stop [port|all]', () => import('./dev-impl').then((m) => m.serveCommand));
export const npmCommand = lazyCommand('npm', 'manage package.json; npm run dev serves the project (packages load from esm.sh)', 'npm init | npm install <pkg>[@version]… [-D] | npm uninstall <pkg>… | npm ls | npm run dev', () => import('./dev-impl').then((m) => m.npmCommand));
export const npxCommand = lazyCommand('npx', 'npx vite / serve / http-server start the dev server', 'npx vite | npx serve [dir] | npx http-server [dir]', () => import('./dev-impl').then((m) => m.npxCommand));
