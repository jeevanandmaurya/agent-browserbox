# Changelog

`@jeevanand/agent-browserbox`: the agent. Each section becomes the "What's
new" part of the GitHub release notes (`agent-v*`).

## 0.4.3 (not released yet)

- Background jobs: `shell` takes `background: true` (returns at once with
  the first output); the `job` tool lists jobs, reads new output (waiting up
  to `wait_ms`), or stops one. Ended jobs are reported at the start of the
  next turn; `ToolContext.jobs`, `Agent.jobs`; jobs stop on dispose.

- Model calls that fail with a retryable error (connection lost, 5xx, 429,
  408) are retried after 2, 5, 10 and 20 s (waiting for `online` when the
  browser is offline), as long as nothing of the reply was shown; status
  events show the countdown. OpenAI-compatible 429 and 408 are retryable.
- `send('', { again: true })`: retry after an error, answering the
  conversation as it is.
- A status event ("Waiting for the model…") before every model call.
- A chat that was disposed is not saved again by its last events.

## 0.4.2

- **Isolated chats**: `create({ isolated: true })`, or `handle.isolate(on)`,
  runs a chat on a copy-on-write copy of its project folder at
  `/work/<id>` (its changes kept in `.sessions/<id>/work`, deleted with the
  chat). `handle.isolation()` lists what it changed; `applyWork(paths?)` and
  `discardWork(paths?)` copy the changes into the folder or throw them away.
  The shell, file tools, sub-agents and the prompt use the copy; artifacts
  stay in the project. Snapshots carry `isolated`.
- `preview` tool (when the host gives `ui.preview`): open a page of the box
  or a dev server page, snapshot (numbered elements), click, type, select,
  check, press, scroll, wait, eval (an `exec` permission), console,
  screenshot (an image for the model), close.

## 0.4.1

- `attachmentsDir(id)`: a chat's attachments live with it
  (`.sessions/<id>/files`); `deleteSession` and ending a private chat remove
  them.
- Fixed: Gemini (OpenAI-compatible API) refused the second request of a tool
  call: the `extra_content` signature on its tool calls is kept on the block
  (`extra`) and echoed back to Google's API only.
- Google Gemini preset; `apiBase()` corrects Google's bare address; clearer
  `unreachable()` messages for services that accept browser requests.
- The built-in model streams: text is shown as it arrives, holding back what
  may become a tool call. `ui.builtinPrompt` takes an `onChunk` callback.
- New commands `project` and `chats` (in `AGENT_COMMANDS`): manage projects
  and saved chats from a terminal; deleting needs a person at the terminal
  (`Tty.interactive`) who confirms.
- `delete_artifact` tool (an `fs.write` permission), and `update_artifact`
  takes `restore: <version>` (the old version becomes the newest).
- `AgentCommand.section`: where the shell's `help` lists a command.
- A chat opened in a second window while it works shows what it is doing:
  `AgentSnapshot.live` holds the current step's events not yet in
  `messages` (text so far, running tools), for the window to replay.

## 0.4.0

- The browser's built-in model gets the short prompt and reduced tool set of
  small models, fits the conversation to the window the browser reports
  (`contextWindow`, or `inputQuota` in earlier Chrome), and retries with less
  history when it does not fit. `builtinPrompt` hosts return `{ text, window }`.
- Fixed: the package list in the prompt had a bogus `=` entry (the legend
  under `pkg list` was read as a package).
- `AgentInfo.waiting` (from `live()`): the chat waits for an approval or an
  answer (agent process ids belong to the host's own table).
- **The browser's built-in model** (`provider: 'builtin'`, Chrome's Prompt
  API) as a model source, with the same text tool-call format as the WebGPU
  models. In a worker, `ui.builtinPrompt` lets a page run the prompt;
  `runBuiltinPrompt` and `builtinAvailability` are exported for that page.
- `run_wasm` programs see the working folder's files; the prompt points to
  `pkg search` for more software.
- **Read before edit**: an existing file must be read (or written) by the
  agent before it edits or overwrites it, and an edit is refused when the
  file changed since (the user, a command or another agent changed it); the
  model reads it again. Compaction forgets what was read.
- **Accept-edits mode** (`perms.mode: 'edits'`): file changes go through
  without asking, except under `/mnt`; commands, code, network and system
  actions still ask. Rules still come first.
- **Parallel sub-agents**: spawn_agent calls in one turn run together, up
  to 4 at a time. Each sub-agent's last 200 messages are kept with the
  session (`subagents`, in snapshots and saved sessions).
- **A model per agent**: `model:` in a custom agent's file, or
  `subagentModel` in the config, for sub-agents on an API.
- **Hooks** (`agent.hooks`, `runHooks`): PreToolUse, PostToolUse,
  UserPromptSubmit, Stop, SubagentStop and SessionStart. A hook is a shell
  command with `$BBX_EVENT`, `$BBX_TOOL`, `$BBX_FILE` and `$BBX_INPUT` (a
  JSON file) substituted; exit 2 blocks (a tool, a message) or, for Stop,
  sends the agent back to work (at most 3 times); its output is added for
  PostToolUse, UserPromptSubmit and SessionStart. Each run is an event
  (`hook`). Kept in settings, which no tool writes.
- **Projects** (`agent.projects`, `createProject`, `updateProject`,
  `removeProject`, `getProject`): each has a folder (the agent's working
  folder and its free-to-write area), AGENTS.md, an optional default model
  and pinned knowledge files (about 20,000 tokens in the prompt, the rest
  listed). General is /home/agent: chats from before belong to it.
  `AgentsApi.create({ project })`; sessions, snapshots and live sessions
  carry their project; `listSessions(os, project)` reads an index
  (`.sessions/index.json`), rebuilt from the files when missing.
- **Memory**: a `memory` tool (view, add, replace, remove) with scopes
  `user` (MEMORY.md) and `project` (`.memory/<project>.md`), one entry at a
  time within a 6,000-character budget; changes are file changes (diffs,
  undo). `agent.memory.auto: false` removes the tool. The prompt includes
  both scopes, snapshotted per chat. `addMemory`, `removeMemory`,
  `replaceMemory` for apps.
- **Artifacts**: `create_artifact`, `update_artifact` (exact edits or
  whole content; earlier versions kept) and `read_artifact` (or list), for
  html, markdown, svg, mermaid, code and csv, up to 2 MB a version. Stored
  as files in `<project>/.artifacts/<id>/` (artifact.json + v1, v2…), so
  undo and rewind cover them; `ToolContext.created()` tells undo about
  files a tool creates. Helpers for apps: `listArtifacts`, `readArtifact`,
  `updateArtifact`, `deleteArtifact`, `versionPath`.
- Undo: files inside a folder that did not exist yet are not put back.
- **Scheduled tasks** (`agent.schedules`, `Scheduler`, `nextRunAfter`):
  every N minutes (15 at least), hourly, daily, weekdays or weekly, in a
  project; each run is a chat; unattended permissions from the task
  (`allow.edits/commands/network`), questions answered with a fixed note;
  missed runs run on next start or are skipped; 30-minute limit, 2 at a
  time; optional exclusive lock across workers; outcome in `lastRun`.
- The system prompt states run_js's real time limit.

## 0.3.1

Fixes from a review of the agent:

- Edits are no longer run at the same time: two edit_file calls on one file
  in a turn could each start from the original, and the second undid the
  first. Only tools that change nothing run in parallel now.
- The system prompt follows changes to the model kind, web tools and extra
  instructions instead of keeping the first one for the whole session.
  /compact works on a resumed session.
- Plan mode stays read-only: http_fetch may only GET, without save_to.
- http_fetch's save_to writes only inside the workspace or /tmp (network
  permission was enough to overwrite any file), and is covered by undo.
- Deleting the workspace itself, /tmp, or the agent's saved chats, skills,
  agents, commands and memory asks first. Undo says when a deleted folder was
  too large to keep, instead of restoring part of it quietly.
- run_js asks for permission to run code (network is asked for separately),
  and its description states the real time limit (2 minutes).
- OpenAI-compatible APIs: token counts are requested and read (they were
  always 0, so the context meter and auto-compaction ran on estimates); a
  reply cut off by the output limit no longer runs its half-written tool
  call; tool calls sent without an index are no longer dropped.

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

Also new:

- **Images**: `send(text, { images })` shows the model image files from the
  box (PNG, JPEG, GIF, WebP up to 5 MB), and the new `view_image` tool lets it
  look at images itself. Tools can return `{ text, images }`. Conversations
  keep only the paths; image data is read when a request is sent.
- **Permission rules** (`perms.rules`, `loadRules`/`saveRules`, `decide`):
  allow, always ask or deny by command, path, URL or tool name, before the
  permission mode. Deny wins over ask, ask over allow; a command line is
  allowed only when every command in it is, and never when it substitutes
  commands.

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
