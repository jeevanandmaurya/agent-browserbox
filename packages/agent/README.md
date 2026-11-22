# @jeevanand/agent-browserbox

The BrowserBox agent, as a library: the same agent as the BrowserBox app's,
working inside a [BrowserBox](../sdk) (a sandboxed computer in the browser)
through the SDK. Nothing it does can touch your page or the user's machine.

```sh
npm install @jeevanand/agent-browserbox @jeevanand/agent-browserbox-sdk
```

```ts
import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { Agent, AgentOs, SECRET, saveConfig } from '@jeevanand/agent-browserbox';

const box = await BrowserBox.boot({ id: 'my-project' });
const os = await AgentOs.create(box, {
  secrets: { [SECRET.anthropic]: apiKey },
  ui: { notify: (n) => toast(n.title), openApp: (id, args) => show(id, args) },
});
saveConfig(os, { provider: 'anthropic', anthropicModel: 'claude-opus-5-5', effort: 'medium' });

const agent = new Agent(os, {
  onEvent: (e) => render(e), // text, thinking, tool_start, tool_end, file_change, todos, usage, compact, done, …
  ask: (question, options) => askTheUser(question, options),
});
await agent.send('Make a todo app in ./todo, serve it, and check the console for errors');
```

## What it does

- **Tools**, all working in the box:
  - files: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `move_path`, `delete_path`
  - code: `shell` (a session that keeps `cd` and variables), `run_js`, `run_python` (once `pkg install python`), `run_wasm`, `gpu_compute` (WebGPU in the page)
  - web projects: `dev_server`, `preview_logs`, `show_html`
  - shipping: `github` (clone, push, pull requests) and `deploy` (Netlify, Vercel, GitHub Pages)
  - the web: `http_fetch`, plus Claude's web search and fetch
  - people: `ask_user`, `notify`, `open_app`, clipboard, `speak`
  - the box: `system_info`, `list_processes`, `kill_process`
  - work: `todo_write`, `use_skill`, `spawn_agent` (sub-agents)
  - plus tools from MCP connectors
- **Checkpoints and undo**: every file change is shown as a diff (`file_change`
  events), and `agent.rewind(index, true)` puts the conversation and the
  files back to before a message.
- **Compaction**: near the context limit the conversation is summarised
  automatically (or with `agent.compact()`); the full transcript is kept.
- **Plan mode**: `agent.send(text, { plan: true })` investigates with
  read-only tools and answers with a plan.
- **Skills, custom agents and slash commands** from Markdown files in the
  agent's home (`/home/agent/skills`, `/agents`, `/commands`); examples are
  written there on first use. Memory in `/home/agent/MEMORY.md`.
- **Permissions**: with a `prompter`, writing outside the agent's workspace,
  running code, network and system actions ask first (once, always or deny);
  without one, everything inside the box is allowed.
- **Sessions**: `AgentManager` keeps several conversations, saves them in the
  box (`/home/agent/.sessions`) and resumes them; `listSessions(os)` lists them.
- **Models**: Claude (official Anthropic SDK: adaptive thinking, prompt
  caching, server-side fallback), any OpenAI-compatible server (Ollama, LM
  Studio, OpenRouter, …), or a model running in the tab on WebGPU (install the
  optional `@mlc-ai/web-llm`). Or pass your own: `AgentOs.create(box, { provider })`.

## `AgentOs.create(box, options)`

| Option | |
|---|---|
| `settings`, `onSettingsChange` | The agent's settings: model config (`saveConfig` / `loadConfig`), permission mode and grants, MCP connectors, … Pass stored values in; store what `onSettingsChange` reports. In memory by default. |
| `secrets` | API keys and tokens by name (`SECRET.anthropic`, `SECRET.openai`, GitHub/Netlify/Vercel tokens, MCP tokens): a map or your own store. |
| `prompter` | `(request) => 'once' \| 'always' \| 'deny'` for gated actions. |
| `ui` | What only your app can do: `notify`, `openApp` with the `apps` it can open, `clipboardRead`/`clipboardWrite`, `speak`. Tools that need one are offered or fail clearly without it. |
| `provider` | A model of your own instead of the configured one. |
| `seed` | Write the example skills, agents and commands on first use (default true). |

**API keys in the browser:** a key in a web page is readable by whoever uses
that page. Use your users' own keys, or point a provider at a key-holding
proxy of yours.

## License

MIT
