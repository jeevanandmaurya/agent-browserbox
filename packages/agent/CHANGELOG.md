# Changelog

`@jeevanand/agent-browserbox`: the agent. Each section becomes the "What's
new" part of the GitHub release notes (`agent-v*`).

## 0.2.0

First release of the agent. (0.1.0 under this name was the SDK, before it was
renamed to `@jeevanand/agent-browserbox-sdk`.)

- `new Agent({ box, model })` works inside a BrowserBox through the SDK;
  `send()` streams text, thinking, tool calls, results, todos and usage;
  `run()` returns the final answer; `stop()` stops it cleanly.
- Models: Claude (`anthropic()`, official SDK, adaptive thinking, prompt
  caching, server-side fallback) and any OpenAI-compatible server (`openai()`).
- Tools on the box: read, write and edit files, list, glob, grep, shell,
  sandboxed JavaScript, and a todo list. Inputs are validated before running;
  errors go back to the model.
- `approve` hook before each tool call; sessions saved with `toJSON()` and
  continued with `Agent.restore()`.
