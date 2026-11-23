# Changelog

`@jeevanand/agent-browserbox`: the agent. Each section becomes the "What's
new" part of the GitHub release notes (`agent-v*`).

## 0.3.0

Models come from three general sources instead of a special case for each
service. Breaking for code that set the model config directly; saved settings
and keys move across on their own.

- `provider` is `api`, `local` or `webgpu`. An API is an address and a model
  (`apiBaseUrl`, `apiModel`): Anthropic's address uses Anthropic's API
  (adaptive thinking, prompt caching, web search and fetch), any other uses
  the OpenAI protocol. `API_PRESETS` lists Anthropic, OpenAI, OpenRouter, Groq,
  Together, Mistral and Ollama Cloud.
- API keys are kept per service: `SECRET.api(baseUrl)`; `apiKeyFor()` also
  finds keys saved under the old names.
- Removed: `anthropicModel`, `effort`, `webSearch`, `openaiBaseUrl`,
  `openaiModel`, `ANTHROPIC_MODELS`, `SECRET.anthropic`, `SECRET.openai`.
  `webllmModel` is now `webgpuModel`.
- `probeModels(baseUrl, key, signal, { kind })` lists an API's models,
  Anthropic's included (`probeOpenAi` is kept as an alias).
- `setup` asks for an API key for any service: Anthropic and OpenRouter keys
  are recognised, others ask for the address.

## 0.2.0

First release of the agent as a library: the BrowserBox app's agent, moved
into this package and working in a BrowserBox through the SDK. (0.1.0 under
this name was the SDK, before it was renamed to `@jeevanand/agent-browserbox-sdk`.)

- All of the app agent's tools (files, shell sessions, JavaScript, Python,
  WebAssembly, WebGPU, dev servers and previews, GitHub and deploys, the web,
  the user, processes, todos, skills and sub-agents) plus MCP connectors.
- Checkpoints with diffs and undo (`rewind`), automatic and manual
  compaction, plan mode, skills, custom agents and slash commands, memory,
  sessions (`AgentManager`), and permission prompts.
- Claude, OpenAI-compatible servers, in-browser WebGPU models, or your own
  model (`AgentOs.create(box, { provider })`).
- `AgentOs` gives the agent the box (through the SDK) and what only the app
  can provide: settings, keys, prompts, notifications, opening apps.
- Needs `@jeevanand/agent-browserbox-sdk` 0.2.0 or later.
