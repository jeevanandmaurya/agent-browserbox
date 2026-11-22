# @jeevanand/agent-browserbox

An AI agent that works inside a [BrowserBox](../sdk): a sandboxed computer
that runs in the browser. The agent reads and writes files, searches, runs
shell commands and JavaScript, all inside the box, so nothing it does can
touch your page or the user's machine.

It works with Claude or any OpenAI-compatible model (Ollama, LM Studio,
OpenRouter, …), and runs in the browser with no backend.

```sh
npm install @jeevanand/agent-browserbox @jeevanand/agent-browserbox-sdk
```

```ts
import { BrowserBox } from '@jeevanand/agent-browserbox-sdk';
import { Agent, anthropic } from '@jeevanand/agent-browserbox';

const box = await BrowserBox.boot({ id: 'my-project' });
const agent = new Agent({ box, model: anthropic({ apiKey }) });

for await (const e of agent.send('Make a small todo app in ./todo and check it runs')) {
  if (e.type === 'text') ui.append(e.delta);
  if (e.type === 'tool_call') ui.status(e.call.summary); // "Write todo/index.html"
  if (e.type === 'done') ui.finish(e.text);
}
```

Or, for just the answer: `const answer = await agent.run('…')`.

## Models

| | |
|---|---|
| `anthropic({ apiKey, model?, effort?, webSearch? })` | Claude, through the official Anthropic SDK (loaded only when used). Default model `claude-opus-5-5`, effort `medium`. Uses adaptive thinking, prompt caching and, on models that support it, server-side fallback when a request is declined. |
| `openai({ baseUrl, model, apiKey?, contextWindow?, relay? })` | Any OpenAI-compatible chat-completions server. In a browser the server must allow requests from your page (CORS); `relay` is for those that don't. |

Or pass your own object implementing `Provider`.

**API keys in the browser:** a key you put in a web page is readable by
whoever uses that page. Use your users' own keys, or a key-holding proxy of
yours (`openai({ baseUrl: 'https://your-proxy/…' })`) for a shared one.

## Tools

The agent works through these, each acting on the box: `read_file`,
`write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `shell` (the box's
`bbsh`), `run_js` (sandboxed JavaScript) and `todo_write`. Add your own with
`tools: [tool({ name, description, input_schema, describe, run })]`.

Every tool input is checked against its schema before it runs, and every
error goes back to the model as a tool result, so the agent can correct itself.

## Options

| Option | Default | |
|---|---|---|
| `box` | required | The box to work in. |
| `model` | required | `anthropic(…)`, `openai(…)` or your own `Provider`. |
| `cwd` | the box's home | Working folder for relative paths and commands. |
| `instructions` | | Extra instructions for the system prompt. |
| `approve` | allow all | `(call) => boolean`: asked before each tool call. Declined calls are reported to the model. |
| `maxSteps` | 50 | Model calls per `send()`. |
| `tools` | | Extra tools. |

Network access from inside the box is controlled separately, by the box's
own `permissions` option (denied by default).

## Events

`send()` yields, in order: `text` and `thinking` deltas as they stream,
`status`, `tool_call` (with a one-line `summary`), `tool_result`, `todos`,
`usage` per model call, `error` if the model fails, and always a final
`done` with a `reason` (`end`, `max_steps`, `max_tokens`, `refusal`,
`stopped`, `error`) and the final `text`.

`agent.stop()` stops a run; every tool call the model made still gets a
result, so the conversation stays valid to continue.

## Sessions

`agent.toJSON()` is the whole conversation (JSON). Continue it later with
`Agent.restore(saved, { box, model })`, for example after saving it in the
box: `box.fs.writeFile('.sessions/today.json', JSON.stringify(agent))`.

## Not yet

Context compaction for very long sessions, skills, MCP connectors,
sub-agents, checkpoints with undo, and in-browser (WebGPU) models are in the
BrowserBox app and come to this package in later versions.

## License

MIT
