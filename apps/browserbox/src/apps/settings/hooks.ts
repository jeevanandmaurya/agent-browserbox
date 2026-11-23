import { HOOK_EVENTS, HOOKS_KEY, loadHooks, type Hook, type HookEvent } from '@jeevanand/agent-browserbox/ui';
import type { AppContext } from '@/ui/apps';
import { debounce, h } from '@/ui/dom';
import { heading } from './nav';

const EVENT_HELP: Record<HookEvent, string> = {
  PreToolUse: 'before a tool runs: exit 2 blocks it',
  PostToolUse: 'after a tool ran: output is added to its result',
  UserPromptSubmit: 'when you send a message: output is added, exit 2 blocks it',
  Stop: 'when the agent is done: exit 2 sends it back to work',
  SubagentStop: 'when a sub-agent is done',
  SessionStart: 'when a chat starts: output is added',
};

const toolEvent = (e: HookEvent) => e === 'PreToolUse' || e === 'PostToolUse';

/**
 * Hooks: commands that run at points in the agent's work. Kept in settings,
 * where the agent cannot change them, so it can never give itself hooks.
 */
export function hooksSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const list = h('div', { class: 'st-hooks' });
  let hooks: Hook[] = [];
  let mine = '';
  const store = () => {
    const keep = hooks.filter((x) => x.command.trim());
    mine = JSON.stringify(keep);
    os.settings.set(HOOKS_KEY, keep);
    saved();
  };
  const storeLater = debounce(store, 500);

  const row = (hk: Hook, i: number) => {
    const event = h('select', { class: 'select', 'aria-label': 'Event', onchange: () => ((hk.event = event.value as HookEvent), (matcher.hidden = !toolEvent(hk.event)), (help.textContent = EVENT_HELP[hk.event]), store()) }, HOOK_EVENTS.map((e) => h('option', { value: e }, e)));
    event.value = hk.event;
    const matcher = h('input', { class: 'input mono', value: hk.matcher ?? '', placeholder: 'tools, e.g. edit_file|write_file', 'aria-label': 'Tools', autocomplete: 'off', spellcheck: false, hidden: !toolEvent(hk.event) });
    matcher.addEventListener('input', () => ((hk.matcher = matcher.value), storeLater()));
    const command = h('input', { class: 'input mono', value: hk.command, placeholder: 'command, e.g. echo "$BBX_FILE changed"', 'aria-label': 'Command', autocomplete: 'off', spellcheck: false });
    command.addEventListener('input', () => ((hk.command = command.value), storeLater()));
    command.addEventListener('change', store);
    const on = h('input', { type: 'checkbox', checked: hk.enabled, 'aria-label': 'Enabled', onchange: () => ((hk.enabled = on.checked), store()) });
    const help = h('span', { class: 'muted st-note' }, EVENT_HELP[hk.event]);
    return h(
      'div',
      { class: 'st-hook' },
      h('div', { class: 'st-hook-top' }, on, event, matcher, h('button', { class: 'btn small', type: 'button', 'aria-label': `Remove hook ${hk.command}`, onclick: () => (hooks.splice(i, 1), store(), render()) }, 'Remove')),
      command,
      help,
    );
  };

  const render = () => {
    hooks = loadHooks(os);
    mine = JSON.stringify(hooks);
    list.replaceChildren(...(hooks.length ? hooks.map(row) : [h('p', { class: 'muted st-note' }, 'No hooks yet.')]));
  };
  render();
  ctx.on('settings:change', ({ key }) => key === HOOKS_KEY && JSON.stringify(loadHooks(os)) !== mine && render());

  const add = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        hooks.push({ id: crypto.randomUUID(), event: 'PostToolUse', matcher: 'edit_file|write_file', command: '', enabled: true });
        list.replaceChildren(...hooks.map(row));
        list.querySelector<HTMLInputElement>('.st-hook:last-child input[aria-label="Command"]')?.focus();
      },
    },
    'Add hook',
  );

  return h(
    'div',
    { class: 'st-section' },
    heading('Hooks', 'Commands that run at points in the agent’s work: check every edit, block a command, run the tests when it says it is done.'),
    h(
      'p',
      { class: 'muted st-note' },
      'A hook runs in the BrowserBox shell, in the agent’s folder, without asking: only add commands you trust. In the command, $BBX_EVENT, $BBX_TOOL and $BBX_FILE are replaced by the event, the tool and the file it works on, and $BBX_INPUT by a JSON file with all the details. Exit 0: fine (for some events its output is added for the agent); exit 2: block, and its output tells the agent why; anything else: the hook failed and you are told. Hooks stop after 60 seconds.',
    ),
    list,
    add,
    h('p', { class: 'muted st-note' }, 'The agent cannot see or change this list.'),
  );
}
