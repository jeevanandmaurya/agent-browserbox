import { agentsOf } from '@/app/agents';
import { MCP_KEY, mcpTokenName, type McpServerConfig } from '@jeevanand/agent-browserbox/ui';
import type { AppContext } from '@/ui/apps';
import { confirmDialog } from '@/ui/dialog';
import { h } from '@/ui/dom';
import { errText, heading, nextId } from './nav';

const NAME = /^[a-zA-Z0-9][\w-]{0,31}$/;

/** MCP connectors: remote servers whose tools the agent can use. */
export function connectorsSection(ctx: AppContext, saved: () => void): HTMLElement {
  const { os } = ctx;
  const read = () => os.settings.get<McpServerConfig[]>(MCP_KEY, []);
  const write = (list: McpServerConfig[]) => {
    os.settings.set(MCP_KEY, list);
    saved();
  };
  const list = h('ul', { class: 'st-list ex-list' });

  function render(): void {
    const servers = read();
    list.replaceChildren(...(servers.length ? servers.map(row) : [h('li', { class: 'muted' }, 'No connectors yet.')]));
  }

  function row(s: McpServerConfig): HTMLElement {
    const result = h('div', { class: 'cn-result', hidden: true });
    const toggle = h('input', {
      type: 'checkbox',
      checked: s.enabled,
      'aria-label': `Enable ${s.name}`,
      onchange: () => write(read().map((x) => (x.name === s.name ? { ...x, enabled: toggle.checked } : x))),
    });
    const tokenState = h('span', { class: 'badge' }, '…');
    void os.secrets.has(mcpTokenName(s.name)).then((has) => (tokenState.textContent = has ? 'token saved' : 'no token'));
    async function test(): Promise<void> {
      result.hidden = false;
      result.replaceChildren(h('span', { class: 'muted' }, s.via === 'anthropic' ? 'Connectors used through Anthropic are reached by Anthropic’s servers, so they can only be tested by sending a message.' : 'Connecting…'));
      if (s.via === 'anthropic') return;
      try {
        const tools = await agentsOf(os).probeMcp(s.name);
        result.replaceChildren(
          h('span', { class: 'st-ok' }, `Connected · ${tools.length} tool${tools.length === 1 ? '' : 's'}`),
          h('ul', { class: 'cn-tools' }, tools.map((t) => h('li', null, h('code', null, t.name), t.description ? h('span', { class: 'muted' }, ` — ${t.description.split('\n')[0]!.slice(0, 140)}`) : null))),
        );
      } catch (err) {
        result.replaceChildren(h('span', { class: 'st-error' }, errText(err)));
      }
    }
    return h(
      'li',
      { class: 'ex-row cn-row' },
      h('label', { class: 'ex-switch' }, toggle),
      h(
        'div',
        { class: 'ex-text' },
        h('span', { class: 'ex-name' }, s.name, ' ', h('span', { class: 'badge' }, s.via === 'anthropic' ? 'via Anthropic' : 'direct'), ' ', tokenState),
        h('span', { class: 'muted ex-desc mono' }, s.url),
        result,
      ),
      h(
        'div',
        { class: 'ex-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => void test() }, 'Test'),
        h(
          'button',
          {
            class: 'btn small ghost',
            type: 'button',
            'aria-label': `Remove ${s.name}`,
            onclick: async () => {
              if (!(await confirmDialog(`Remove ${s.name}?`, 'The agent will no longer see its tools. Its saved token is deleted too.', 'Remove', true))) return;
              await os.secrets.delete(mcpTokenName(s.name));
              write(read().filter((x) => x.name !== s.name));
            },
          },
          'Remove',
        ),
      ),
    );
  }

  // --- add form ---------------------------------------------------------------
  const id = (p: string) => nextId(`cn-${p}`);
  const nameIn = h('input', { class: 'input', id: id('name'), placeholder: 'e.g. github', autocomplete: 'off' });
  const urlIn = h('input', { class: 'input mono', id: id('url'), type: 'url', placeholder: 'https://example.com/mcp', autocomplete: 'off' });
  const tokenIn = h('input', { class: 'input mono', id: id('token'), type: 'password', placeholder: 'Optional bearer token', autocomplete: 'off' });
  const viaSel = h('select', { class: 'select', id: id('via') }, h('option', { value: 'direct' }, 'Direct from this browser'), h('option', { value: 'anthropic' }, 'Through Anthropic (Anthropic models only)'));
  const formError = h('p', { class: 'st-error', hidden: true });
  const form = h(
    'form',
    {
      class: 'st-panel',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        formError.hidden = true;
        const name = nameIn.value.trim();
        let url: URL;
        try {
          url = new URL(urlIn.value.trim());
        } catch {
          url = new URL('invalid:');
        }
        const problem = !NAME.test(name) ? 'Name: letters, digits, dashes and underscores (up to 32).' : read().some((x) => x.name === name) ? `A connector named ${name} already exists.` : url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) ? 'URL must be https:// (or http://localhost).' : '';
        if (problem) {
          formError.textContent = problem;
          formError.hidden = false;
          return;
        }
        if (tokenIn.value) await os.secrets.set(mcpTokenName(name), tokenIn.value);
        write([...read(), { name, url: url.href, enabled: true, via: viaSel.value === 'anthropic' ? 'anthropic' : 'direct' }]);
        form.reset();
      },
    },
    h('strong', null, 'Add a connector'),
    h('div', { class: 'field' }, h('label', { for: nameIn.id }, 'Name'), nameIn),
    h('div', { class: 'field' }, h('label', { for: urlIn.id }, 'Server URL (Streamable HTTP)'), urlIn),
    h('div', { class: 'field' }, h('label', { for: tokenIn.id }, 'Token'), tokenIn, h('p', { class: 'muted st-note' }, 'Stored encrypted.')),
    h('div', { class: 'field' }, h('label', { for: viaSel.id }, 'Connect'), viaSel),
    formError,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add connector')),
  );

  ctx.on('settings:change', ({ key }) => key === MCP_KEY && render());
  render();

  return h(
    'div',
    { class: 'st-section' },
    heading('Connectors', 'Remote MCP servers (Streamable HTTP).'),
    h('p', { class: 'st-note muted' }, 'Direct: called from this browser (the server must allow CORS). Through Anthropic: Anthropic’s API connects instead (Anthropic models only).'),
    list,
    form,
  );
}
