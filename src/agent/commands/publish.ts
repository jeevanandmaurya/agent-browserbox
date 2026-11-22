import { lazyCommand } from '@/shell/commands/lazy';

export const ghCommand = lazyCommand('gh', 'GitHub: sign in, create and clone repositories, push a folder, open pull requests', 'gh auth login|status|logout · gh repo create <name> [--public] · gh repo clone <owner/repo> [dir] · gh push [dir] [--repo owner/name] [--branch b] [-m msg] · gh pr create --head <branch> --title <t> [--body b] [--base main] [--repo owner/name]', () => import('./publish-impl').then((m) => m.ghCommand));
export const deployCommand = lazyCommand('deploy', 'build a project for production and publish it to Netlify, Vercel or GitHub Pages', 'deploy [dir] --to netlify|vercel|github-pages [--name site-name] [--repo owner/name]', () => import('./publish-impl').then((m) => m.deployCommand));
