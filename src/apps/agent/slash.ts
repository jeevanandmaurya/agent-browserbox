import { loadExtensions } from '@jeevanand/agent-browserbox/ui';
import type { Kernel } from '@/kernel/api';
import { h } from '@/ui/dom';

export interface SlashCommand {
  name: string;
  description: string;
  kind: 'built-in' | 'custom';
  /** Built-ins act directly; custom commands expand into a prompt. */
  run?: (args: string) => void;
  template?: string;
}

/** Fills a custom command's template: $ARGUMENTS becomes the text after the command. */
export function expandCommand(template: string, args: string): string {
  return template.includes('$ARGUMENTS') ? template.replaceAll('$ARGUMENTS', args) : args ? `${template}\n\n${args}` : template;
}

/**
 * The menu that appears when a message starts with "/". Built-in commands act
 * on the window; custom commands come from Markdown files in
 * /home/agent/commands and are sent to the agent as prompts.
 */
export function slashMenu(os: Kernel, input: HTMLTextAreaElement, builtins: SlashCommand[]) {
  const menu = h('div', { class: 'popover sc-menu', role: 'listbox', 'aria-label': 'Commands', hidden: true });
  let all: SlashCommand[] = builtins;
  let shown: SlashCommand[] = [];
  let index = 0;

  async function reload(): Promise<void> {
    const custom = (await loadExtensions(os, 'command').catch(() => [])).filter((c) => c.enabled);
    all = [...builtins, ...custom.filter((c) => !builtins.some((b) => b.name === c.name)).map((c): SlashCommand => ({ name: c.name, description: c.description, kind: 'custom', template: c.body }))];
  }

  function render(): void {
    const m = /^\/([\w-]*)$/.exec(input.value);
    shown = m ? all.filter((c) => c.name.startsWith(m[1]!.toLowerCase())) : [];
    menu.hidden = !shown.length;
    input.setAttribute('aria-expanded', String(!menu.hidden));
    if (menu.hidden) return;
    index = Math.min(index, shown.length - 1);
    menu.replaceChildren(
      ...shown.map((c, i) =>
        h(
          'button',
          {
            class: 'pop-item sc-item',
            type: 'button',
            role: 'option',
            'aria-selected': String(i === index),
            onpointerdown: (e: Event) => e.preventDefault(),
            onclick: () => pick(c),
          },
          h('span', { class: 'sc-name' }, `/${c.name}`),
          h('span', { class: 'sc-desc' }, c.description),
        ),
      ),
    );
  }

  function pick(c: SlashCommand): void {
    input.value = `/${c.name} `;
    input.dispatchEvent(new Event('input'));
    menu.hidden = true;
    input.focus();
  }

  input.addEventListener('focus', () => void reload());
  input.addEventListener('input', render);
  input.addEventListener('blur', () => (menu.hidden = true));
  input.setAttribute('aria-autocomplete', 'list');

  return {
    el: menu,
    reload,
    /** Handles arrow keys, Tab and Enter while the menu is open. Returns true when it used the key. */
    key(e: KeyboardEvent): boolean {
      if (menu.hidden) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        index = (index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        render();
        return true;
      }
      // Enter on a fully typed command runs it; otherwise it completes the highlighted one.
      if (e.key === 'Enter' && !e.shiftKey && shown.some((c) => input.value.trim() === `/${c.name}`)) {
        menu.hidden = true;
        return false;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        pick(shown[index]!);
        return true;
      }
      if (e.key === 'Escape') {
        menu.hidden = true;
        return true;
      }
      return false;
    },
    /** Resolves a submitted "/name args" line. */
    find(text: string): { command: SlashCommand; args: string } | null {
      const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      const command = m && all.find((c) => c.name === m[1]!.toLowerCase());
      return command ? { command, args: (m[2] ?? '').trim() } : null;
    },
  };
}
