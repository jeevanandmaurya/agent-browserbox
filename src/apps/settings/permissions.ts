import type { Capability, PermMode } from '@/kernel/perms';
import type { AppContext } from '@/ui/apps';
import { h } from '@/ui/dom';
import { errText, heading, nextId } from './nav';

const CAP_LABEL: Record<Capability, string> = {
  'fs.write': 'Modify files',
  exec: 'Run code and shell commands',
  net: 'Use the network',
  clipboard: 'Use the clipboard',
  notify: 'Send notifications',
  system: 'Control the system (open apps, end processes)',
};

const MODES: Array<{ id: PermMode; title: string; text: string }> = [
  { id: 'ask', title: 'Ask before risky actions', text: 'The agent must get your OK before it writes files, runs code, uses the network or controls the system. Choose “Always allow” in a prompt to skip future prompts for that kind of action.' },
  { id: 'auto', title: 'Allow everything inside the sandbox', text: 'No prompts. The agent can freely change files in the virtual filesystem, run code and make network requests. Best for unattended tasks you trust.' },
];

function radioGroup<T extends string>(legend: string, options: Array<{ id: T; title: string; text?: string }>, value: T, onchange: (v: T) => void) {
  const name = nextId('radio');
  const inputs = options.map((o) => h('input', { type: 'radio', name, value: o.id, checked: o.id === value, onchange: () => onchange(o.id) }));
  const el = h(
    'fieldset',
    { class: 'st-choices' },
    h('legend', null, legend),
    options.map((o, i) => h('label', { class: 'st-choice' }, inputs[i], h('span', null, h('strong', null, o.title), o.text ? h('span', { class: 'muted' }, o.text) : null))),
  );
  return { el, set: (v: T) => inputs.forEach((inp, i) => (inp.checked = options[i]!.id === v)) };
}

export function permissionsSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const mode = radioGroup('When the agent wants to act', MODES, os.perms.mode, (m) => {
    os.perms.mode = m;
    saved();
  });

  const grants = h('ul', { class: 'st-list' });
  const renderGrants = () => {
    const list = os.perms.grants();
    grants.replaceChildren(
      ...(list.length
        ? list.map((cap) =>
            h(
              'li',
              null,
              h('span', null, CAP_LABEL[cap] ?? cap, h('span', { class: 'muted mono' }, ` ${cap}`)),
              h('button', { class: 'btn small', type: 'button', 'aria-label': `Revoke: ${CAP_LABEL[cap] ?? cap}`, onclick: () => (os.perms.revoke(cap), saved()) }, 'Revoke'),
            ),
          )
        : [h('li', { class: 'muted' }, 'None. Choosing “Always allow” in a permission prompt adds a standing grant here.')]),
    );
  };
  renderGrants();
  ctx.on('settings:change', ({ key }) => {
    if (key === 'perms.grants') renderGrants();
    if (key === 'perms.mode') mode.set(os.perms.mode);
  });

  // Browser notification permission (for agent task alerts when the tab is in the background).
  const N = globalThis.Notification;
  const notifState = h('span', { class: 'badge' });
  const notifBtn = h('button', { class: 'btn', type: 'button', onclick: () => void requestNotif() }, 'Allow notifications');
  const notifNote = h('p', { class: 'muted st-note' });
  const renderNotif = () => {
    if (!N) {
      notifState.textContent = 'not supported';
      notifBtn.hidden = true;
      notifNote.textContent = 'This browser does not support web notifications.';
      return;
    }
    const p = N.permission;
    notifState.textContent = p === 'default' ? 'not asked yet' : p;
    notifState.className = `badge ${p === 'granted' ? 'ok' : p === 'denied' ? 'err' : ''}`;
    notifBtn.hidden = p !== 'default';
    notifNote.textContent =
      p === 'denied'
        ? 'Notifications are blocked. To change this, use the site settings in your browser’s address bar.'
        : 'Lets BrowserBox alert you when a long agent task finishes while this tab is in the background.';
  };
  async function requestNotif(): Promise<void> {
    try {
      await N.requestPermission();
    } catch (err) {
      os.notify({ title: 'Could not request notification permission', body: errText(err), level: 'error' });
    }
    renderNotif();
  }
  renderNotif();

  return h(
    'div',
    { class: 'st-section' },
    heading('Permissions', 'Control what the agent and sandboxed programs may do.'),
    mode.el,
    h(
      'p',
      { class: 'st-callout muted' },
      'Either way, everything runs inside the BrowserBox sandbox: programs cannot reach files on your computer outside the virtual filesystem unless you mount a folder (System → Storage), and saved API keys are never exposed to them.',
    ),
    h('h3', null, 'Standing grants'),
    grants,
    h('h3', null, 'Browser notifications'),
    h('div', { class: 'row st-wrap' }, notifState, notifBtn),
    notifNote,
  );
}

export function appearanceSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const theme = radioGroup(
    'Theme',
    [
      { id: 'dark', title: 'Dark' },
      { id: 'light', title: 'Light' },
    ],
    os.settings.get<string>('ui.theme', 'dark') === 'light' ? 'light' : 'dark',
    (v) => {
      os.settings.set('ui.theme', v);
      saved();
    },
  );
  ctx.on('settings:change', ({ key, value }) => {
    if (key === 'ui.theme') theme.set(value === 'light' ? 'light' : 'dark');
  });
  return h('div', { class: 'st-section' }, heading('Appearance'), theme.el);
}
