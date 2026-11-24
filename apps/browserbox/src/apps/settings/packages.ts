import type { IndexedPackage, PackageInfo, PackageSource } from '@jeevanand/agent-browserbox-runtime/client';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { debounce, h } from '@/ui/dom';
import { errText, heading } from './nav';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const sizeOf = (p: IndexedPackage) => p.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Settings → Packages: the terminal's software. Built-in packages, packages
 * from indexes (the BrowserBox one and any you add), updates, checks and
 * sources. Anything not from the BrowserBox index is installed only after you
 * confirm it here (or in a terminal); the agent cannot.
 */
export function packagesSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  if (!os.pkg) return h('div', { class: 'st-section' }, heading('Packages', ''), h('p', { class: 'muted' }, 'This runtime has no package manager for windows.'));
  const api = os.pkg;

  const status = h('p', { class: 'st-note', role: 'status', 'aria-live': 'polite' });
  const say = (text: string, error = false) => {
    status.className = error ? 'st-note st-error' : 'st-note';
    status.textContent = text;
  };
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search packages', 'aria-label': 'Search packages' });
  const updates = h('div', { class: 'st-sched' });
  const builtinList = h('div', { class: 'st-sched' });
  const indexList = h('div', { class: 'st-sched' });
  const sourceList = h('div', { class: 'st-sched' });
  let builtin: PackageInfo[] = [];
  let indexed: IndexedPackage[] = [];
  let sources: PackageSource[] = [];
  const busy = new Set<string>();

  /** Runs one action on a package, showing it busy and reporting the outcome. */
  const act = async (id: string, label: string, fn: () => Promise<unknown>, done: string) => {
    busy.add(id);
    render();
    say(`${label} ${id}…`);
    try {
      await fn();
      say(done);
      saved();
    } catch (err) {
      say(errText(err), true);
    } finally {
      busy.delete(id);
      await load();
    }
  };

  const remove = async (id: string) => {
    const users = await api.dependents(id).catch(() => [] as string[]);
    if (users.length && !(await confirmDialog(`Remove ${id}?`, `${users.join(', ')} ${users.length > 1 ? 'need' : 'needs'} it and will stop working.`, 'Remove anyway', true))) return;
    await act(id, 'Removing', () => api.remove(id, { force: users.length > 0 }), `Removed ${id}.`);
  };

  const install = async (p: IndexedPackage) => {
    if (!p.official && !(await confirmDialog(`Install ${p.id} ${p.version}?`, `It comes from ${p.source}, not the BrowserBox index: its code has not been checked by BrowserBox. Each file is still checked against the checksum its index lists.`, 'Install'))) return;
    await act(p.id, 'Installing', () => api.install(`${p.id}@${p.version}`), `Installed ${p.id}.`);
  };

  const row = (title: string, badges: string[], text: string, actions: HTMLElement[]) =>
    h(
      'div',
      { class: 'st-sched-item' },
      h('div', { class: 'st-sched-head' }, h('strong', null, title), h('span', { class: 'row st-wrap' }, ...badges.map((b) => h('span', { class: 'badge' }, b)))),
      h('p', { class: 'muted st-note' }, text),
      h('div', { class: 'row st-wrap' }, ...actions),
    );
  const button = (label: string, onclick: () => void, primary = false, disabled = false) => h('button', { class: `btn small${primary ? ' primary' : ''}`, type: 'button', disabled, onclick }, label);

  function render(): void {
    const q = search.value.trim().toLowerCase();
    const match = (...parts: string[]) => !q || parts.join(' ').toLowerCase().includes(q);
    builtinList.replaceChildren(
      ...builtin
        .filter((m) => match(m.id, m.summary, m.commands.join(' ')))
        .map((m) =>
          row(
            m.id,
            [m.installed ? 'Installed' : '', m.bytes ? `${m.estimated ? '~' : ''}${fmt(m.bytes)}` : ''].filter(Boolean),
            `${m.summary}${m.commands.length ? ` · commands: ${m.commands.join(', ')}` : ''}`,
            [busy.has(m.id) ? button('Working…', () => undefined, false, true) : m.installed ? button('Remove', () => void remove(m.id)) : button('Install', () => void act(m.id, 'Installing', () => api.install(m.id), `Installed ${m.id}.`), true)],
          ),
        ),
    );
    const shown = indexed.filter((p) => match(p.id, p.summary, Object.keys(p.commands).join(' '), p.source));
    indexList.replaceChildren(
      ...(shown.length
        ? shown.map((p) =>
            row(
              `${p.id} ${p.version}`,
              [p.kind === 'wasm' ? 'WebAssembly' : p.kind === 'js' ? 'JavaScript' : 'Script', p.official ? 'BrowserBox index' : hostOf(p.source), p.installedVersion ? `Installed ${p.installedVersion}` : '', fmt(sizeOf(p))].filter(Boolean),
              `${p.summary} · commands: ${Object.keys(p.commands).join(', ')}${p.depends?.length ? ` · needs ${p.depends.join(', ')}` : ''}${p.license ? ` · ${p.license}` : ''}`,
              [
                busy.has(p.id)
                  ? button('Working…', () => undefined, false, true)
                  : p.installedVersion
                    ? button('Remove', () => void remove(p.id))
                    : button('Install', () => void install(p), true),
                ...(p.installedVersion && p.installedVersion !== p.version && !busy.has(p.id) ? [button(`Update to ${p.version}`, () => void install(p))] : []),
                ...(p.homepage ? [h('a', { class: 'btn small link', href: p.homepage, target: '_blank', rel: 'noopener' }, 'Homepage')] : []),
              ],
            ),
          )
        : [h('p', { class: 'muted st-note' }, q ? 'No package matches.' : 'No packages in the indexes yet.')]),
    );
    sourceList.replaceChildren(
      ...sources.map((s) =>
        h(
          'div',
          { class: 'st-sched-item' },
          h('div', { class: 'st-sched-head' }, h('span', { class: 'mono' }, s.url), s.official ? h('span', { class: 'badge' }, 'BrowserBox') : button('Remove', () => void removeSource(s.url))),
        ),
      ),
    );
  }

  async function load(refresh = false): Promise<void> {
    try {
      [builtin, indexed, sources] = await Promise.all([api.builtin(), api.index(refresh), api.sources()]);
    } catch (err) {
      say(errText(err), true);
    }
    render();
  }

  async function checkUpdates(): Promise<void> {
    say('Checking the indexes…');
    await load(true);
    const ups = await api.upgradable().catch(() => []);
    updates.replaceChildren(
      ...ups.map((u) =>
        row(u.id, [`${u.from} → ${u.to.version}`], u.to.summary, [
          button('Update', () => void act(u.id, 'Updating', () => api.install(`${u.id}@${u.to.version}`), `Updated ${u.id} to ${u.to.version}.`), true),
        ]),
      ),
    );
    say(ups.length ? `${ups.length} update${ups.length > 1 ? 's' : ''} available.` : 'Everything is up to date.');
  }

  async function verify(): Promise<void> {
    say('Checking every file against its checksum…');
    const bad = await api.verify().catch((err: unknown) => (say(errText(err), true), null));
    if (!bad) return;
    say(bad.length ? `Problems: ${bad.map((b) => `${b.id}/${b.path} ${b.problem}`).join('; ')}. Install the package again to repair it.` : 'Every installed file matches its checksum.', bad.length > 0);
  }

  async function removeSource(url: string): Promise<void> {
    if (!(await confirmDialog('Remove this source?', `${url}\nInstalled packages from it stay installed, but will not be updated.`, 'Remove'))) return;
    await api.removeSource(url).catch((err: unknown) => say(errText(err), true));
    saved();
    await load(true);
  }

  // Add a source (an index of packages someone else publishes).
  const sourceUrl = h('input', { class: 'input mono', type: 'url', placeholder: 'https://example.com/bbx-index.json', 'aria-label': 'Index URL' });
  const addSource = async () => {
    const url = sourceUrl.value.trim();
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) return say('An index needs an https:// link.', true);
    if (!(await confirmDialog('Add this package source?', `${url}\nIts packages have not been checked by BrowserBox. You are asked before each install from it, and the agent cannot install from it.`, 'Add source'))) return;
    try {
      await api.addSource(url);
      sourceUrl.value = '';
      saved();
      await load(true);
      say(`Added ${hostOf(url)}.`);
    } catch (err) {
      say(errText(err), true);
    }
  };

  // Install one package from a link to its bbx-package.json.
  const pkgUrl = h('input', { class: 'input mono', type: 'url', placeholder: 'https://example.com/tool/bbx-package.json', 'aria-label': 'Package URL' });
  const installUrl = async () => {
    const url = pkgUrl.value.trim();
    if (!url) return;
    try {
      say('Reading the package…');
      const p = await api.describeUrl(url);
      const commands = Object.keys(p.commands).join(', ');
      if (!(await confirmDialog(`Install ${p.id} ${p.version}?`, `${p.summary}\nCommands: ${commands}\nFrom ${url}: not in the BrowserBox index, so its code has not been checked.`, 'Install'))) return say('');
      await act(p.id, 'Installing', () => api.installFrom(url), `Installed ${p.id}.`);
      pkgUrl.value = '';
    } catch (err) {
      say(errText(err), true);
    }
  };

  search.addEventListener('input', debounce(render, 120));
  ctx.on('settings:change', ({ key }) => ['pkg.installed', 'pkg.external', 'pkg.sources'].includes(key) && void load());
  void load();

  return h(
    'div',
    { class: 'st-section' },
    heading('Packages', 'Software for the terminal and the agent: built in, and from package indexes. Installed packages work offline. In a terminal: pkg.'),
    h('div', { class: 'row st-wrap' }, search, button('Check for updates', () => void checkUpdates()), button('Verify files', () => void verify())),
    status,
    updates,
    h('h3', null, 'Built in'),
    builtinList,
    h('h3', null, 'From package indexes'),
    indexList,
    h('h3', null, 'Install from a link'),
    h('p', { class: 'muted st-note' }, 'A link to a package’s bbx-package.json. You are asked every time.'),
    h('div', { class: 'row st-wrap' }, pkgUrl, button('Install…', () => void installUrl())),
    h('h3', null, 'Sources'),
    h('p', { class: 'muted st-note' }, 'Indexes of packages. The BrowserBox index installs without asking; packages from others are installed only when you confirm.'),
    sourceList,
    h('div', { class: 'row st-wrap' }, sourceUrl, button('Add source', () => void addSource())),
  );
}
