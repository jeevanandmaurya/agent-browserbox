# Changelog: the BrowserBox app

The app (agent window, desktop, docs) is released on its own, as a site:
`app-v*` releases, served at https://jeevanandmaurya.github.io/agent-browserbox/.
Each section becomes the "What's new" part of the GitHub release notes. The
SDK and runtime have their own changelog in `packages/sdk/CHANGELOG.md`.

## 0.3.0

- **Settings → Model** has three choices: **API** (Anthropic, OpenAI,
  OpenRouter, Groq and others, each with its own key), **Local server** and
  **In this browser**. The Claude-only settings (model list, effort, web
  search switch) are gone; your model and key carry over.
- **Images**: attach or paste images and the agent sees them (with a vision
  model); the chat shows thumbnails. The agent can also look at image files.
- **Permission rules** in Settings → Permissions: allow, always ask or never
  allow particular commands (`git *`, `rm -rf *`), paths, URLs or tools.
- Fixed: the service worker failed to install (it pre-cached kernel pages at
  their old address, now inside the runtime), so the app did not start
  offline or instantly from cache.
- **Profiles**: several people can use BrowserBox in one browser, each with
  their own files, settings, keys and chats (sidebar → your name, or Settings →
  Profile). Your existing data becomes the first profile. A profile can have
  a password: signing out locks its API keys until you sign in again.

## 0.2.0

The app now runs on the released packages instead of its own copy of the
system: the runtime (`@jeevanand/agent-browserbox-runtime` 0.2.0), driven
through the SDK, and the agent (`@jeevanand/agent-browserbox` 0.2.0) in a
shared agent worker. Nothing to do on your side: your files, settings, keys
and chats stay where they were.

- The agent keeps working while you switch or close windows; terminal
  commands it adds (`agent`, `setup`, `gh`, `deploy`) come back when it
  reconnects.
- The agent window loads less code up front.
- The site serves the runtime it was built with at `/runtime/0.2.0/`.

## 0.1.0

First release as a site.

- **Agent window**: chat with Claude, OpenAI-compatible servers (Ollama,
  LM Studio, …) or models running in the tab (WebLLM); plan mode, file diffs
  with undo, context compaction, MCP connectors, skills, custom agents and
  slash commands.
- **Desktop**: Terminal, Files, Editor, Browser, Preview, Task Manager,
  Settings, System Info, GPU Lab and Help, as windows on wide screens and a
  home screen on phones.
- **Shell and packages**: about 50 commands, JavaScript and WebAssembly, and
  installable Python, git, SQLite, zip and esbuild. A dev server for
  React/TypeScript projects, and deploys to Netlify, Vercel or GitHub Pages.
- Real Node.js through WebContainers was removed: BrowserBox is its own runtime.
