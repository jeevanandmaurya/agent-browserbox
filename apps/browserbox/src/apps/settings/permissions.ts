import type { Capability, PermMode } from '@jeevanand/agent-browserbox-runtime/client';
import { loadRules, RULES_KEY, saveRules, type PermRule, type RuleAction, type RuleScope } from '@jeevanand/agent-browserbox/ui';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
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

const ACTIONS: Array<{ id: RuleAction; label: string }> = [
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Always ask' },
  { id: 'deny', label: 'Never allow' },
];
const SCOPES: Array<{ id: RuleScope; label: string; placeholder: string }> = [
  { id: 'shell', label: 'Command', placeholder: 'git *' },
  { id: 'path', label: 'Path', placeholder: '/home/user/private/*' },
  { id: 'url', label: 'URL', placeholder: 'https://api.github.com/*' },
  { id: 'tool', label: 'Tool', placeholder: 'deploy' },
];

/** The rule list: one row per rule (action, scope, pattern), saved as you type. */
function rulesEditor(ctx: AppContext, saved: () => void): { el: HTMLElement; render: () => void; changedElsewhere: () => boolean } {
  const { os } = ctx;
  const list = h('div', { class: 'st-rules' });
  let rules: PermRule[] = [];
  /** What this editor last saved, to tell its own changes from another window's. */
  let mine = '';
  const store = () => {
    const keep = rules.filter((r) => r.pattern.trim());
    mine = JSON.stringify(keep);
    saveRules(os, keep);
    saved();
  };
  const storeLater = debounce(store, 500);
  const sel = <T extends string>(label: string, options: Array<{ id: T; label: string }>, value: T, set: (v: T) => void) => {
    const el = h('select', { class: 'select', 'aria-label': label, onchange: () => set(el.value as T) }, options.map((o) => h('option', { value: o.id }, o.label)));
    el.value = value;
    return el;
  };
  const row = (r: PermRule, i: number) => {
    const pattern = h('input', { class: 'input mono', value: r.pattern, 'aria-label': 'Pattern', placeholder: SCOPES.find((s) => s.id === r.scope)!.placeholder, autocomplete: 'off', spellcheck: false });
    pattern.addEventListener('input', () => ((r.pattern = pattern.value), storeLater()));
    pattern.addEventListener('change', store);
    return h(
      'div',
      { class: 'st-rule' },
      sel('Action', ACTIONS, r.action, (v) => ((r.action = v), store())),
      sel('Applies to', SCOPES, r.scope, (v) => ((r.scope = v), (pattern.placeholder = SCOPES.find((s) => s.id === v)!.placeholder), store())),
      pattern,
      h('button', { class: 'btn small', type: 'button', 'aria-label': `Remove rule ${r.pattern}`, onclick: () => (rules.splice(i, 1), store(), render()) }, 'Remove'),
    );
  };
  const render = () => {
    rules = loadRules(os);
    mine = JSON.stringify(rules);
    list.replaceChildren(...(rules.length ? rules.map(row) : [h('p', { class: 'muted st-note' }, 'No rules yet.')]));
  };
  const add = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        rules.push({ scope: 'shell', pattern: '', action: 'allow' });
        list.replaceChildren(...rules.map(row));
        list.querySelector<HTMLInputElement>('.st-rule:last-child input')?.focus();
      },
    },
    'Add rule',
  );
  render();
  return {
    render,
    changedElsewhere: () => JSON.stringify(loadRules(os)) !== mine,
    el: h(
      'div',
      null,
      h(
        'p',
        { class: 'muted st-note' },
        'Rules come before the setting above. “Never allow” blocks even when everything is allowed; “Always ask” prompts even then; “Allow” skips the prompt. * matches anything, and git * also matches plain git. A command line with &&, ; or | is allowed only when every command in it is; one that runs $(…) or `…` is never allowed by a rule.',
      ),
      list,
      add,
    ),
  };
}

export function radioGroup<T extends string>(legend: string, options: Array<{ id: T; title: string; text?: string }>, value: T, onchange: (v: T) => void) {
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
  const rules = rulesEditor(ctx, saved);
  ctx.on('settings:change', ({ key }) => {
    if (key === 'perms.grants') renderGrants();
    // Changed in another window: show it (this editor's own saves need no redraw).
    if (key === RULES_KEY && rules.changedElsewhere()) rules.render();
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
    h('h3', null, 'Rules'),
    rules.el,
    h('h3', null, 'Standing grants'),
    grants,
    h('h3', null, 'Browser notifications'),
    h('div', { class: 'row st-wrap' }, notifState, notifBtn),
    notifNote,
  );
}
