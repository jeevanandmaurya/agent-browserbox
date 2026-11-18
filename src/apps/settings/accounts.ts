import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { keyField } from './keyfield';
import { heading } from './nav';

const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/**
 * Accounts the agent ships work to: GitHub (push, pull requests, Pages),
 * Netlify and Vercel (deploys). Tokens are stored encrypted; windows can
 * replace or remove them but never read them back.
 */
export function accountsSection(ctx: AppContext, saved: () => void): HTMLElement {
  const block = (title: string, intro: (string | HTMLElement)[], secret: string, placeholder: string) =>
    h('div', { class: 'st-panel' }, h('h3', null, title), h('p', { class: 'muted st-note' }, ...intro), keyField(ctx, { secret, label: 'Token', placeholder, note: 'Stored encrypted in this browser; sent only to the service above.', onSaved: saved }));
  return h(
    'div',
    { class: 'st-section' },
    heading('Accounts', 'Where the agent pushes code and deploys sites. Used by gh, deploy and the agent’s github and deploy tools.'),
    block('GitHub', ['A fine-grained token from ', link('https://github.com/settings/personal-access-tokens', 'github.com/settings/personal-access-tokens'), ': choose the repositories, and give Contents, Pull requests, Pages and Administration read and write.'], 'github.token', 'github_pat_…'),
    block('Netlify', ['A personal access token from ', link('https://app.netlify.com/user/applications', 'app.netlify.com/user/applications'), '.'], 'netlify.token', 'nfp_…'),
    block('Vercel', ['A token from ', link('https://vercel.com/account/tokens', 'vercel.com/account/tokens'), '.'], 'vercel.token', 'Vercel token'),
  );
}
