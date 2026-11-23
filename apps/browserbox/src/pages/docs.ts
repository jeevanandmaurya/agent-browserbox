import '../ui/base.css';
import { docsView, TOPICS } from '@/apps/help/view';
import { AGENT_URL } from '@/app/config';

/**
 * The documentation as a page of its own. It does not start the kernel, so it
 * opens instantly and can be linked to (…/docs/#shipping).
 */
const THEME_KEY = 'bbx-theme';
const theme = (() => {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'dark';
  } catch {
    return 'dark';
  }
})();
document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme === 'light' ? 'light' : 'dark';

const fromHash = () => {
  const id = decodeURIComponent(location.hash.slice(1));
  return TOPICS.some((t) => t.id === id) ? id : undefined;
};
const view = docsView({
  initial: fromHash(),
  footer: 'Open BrowserBox',
  onNavigate: (id) => {
    const t = TOPICS.find((x) => x.id === id);
    document.title = `${t?.title ?? 'Docs'} — BrowserBox docs`;
    if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  },
});
document.getElementById('app')!.replaceChildren(view);
// The footer becomes a link back to the app.
const foot = view.querySelector('.dc-foot');
if (foot) foot.replaceChildren(Object.assign(document.createElement('a'), { href: AGENT_URL, textContent: 'Open BrowserBox →' }));
addEventListener('hashchange', () => {
  const id = fromHash();
  if (id) view.show(id);
});
