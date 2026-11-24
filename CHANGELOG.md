# Changelog: the BrowserBox app

The app (agent window, desktop, docs) is released on its own, as a site:
`app-v*` releases, served at https://jeevanandmaurya.github.io/agent-browserbox/.
Each section becomes the "What's new" part of the GitHub release notes. The
SDK and runtime have their own changelog in `packages/sdk/CHANGELOG.md`.

## 0.4.1

Fixes for a chat open in more than one window (the agent window and the
desktop's Agent, or two tabs):

- Opening a chat that is working shows it working ("Thinking…", the text so
  far, tools running), not stopped.
- An approval or a question waiting in a chat appears in every window that
  opens it, also after closing and opening it again, and can be answered
  there.
- The desktop no longer asks a second time with its own dialog while a window
  shows the chat. If the window that was asked closes, the others ask.

## 0.4.0

- **Accept edits** mode (Shift+Tab or Settings → Permissions): file changes
  go through, commands and the network still ask.
- The agent reads a file before changing it, and never overwrites a change
  you made while it was working.
- **Hooks** (Settings → Hooks): your commands run before or after the
  agent's tools, when you send a message, when a chat starts and when the
  agent is done; exit 2 blocks or sends it back to work.
- **Projects**: separate workspaces with their own folder, chats, memory and
  instructions (sidebar → project picker). Your existing chats are in General.
- **Artifacts**: documents, pages, diagrams, tables and code the agent makes
  for you to keep, with versions, opened beside the chat (and in the
  Artifacts app); edit, copy, download.
- **Scheduled tasks** (Settings → Scheduled, `/schedule`): prompts the agent
  runs on a schedule while BrowserBox is open, each as a chat, with what it
  may do chosen up front and a notification when done.
- **Memory**: the agent remembers facts about you and each project between
  chats; `/remember`, `/forget`, and Settings → Memory to see and edit them.
- Sub-agents run several at once; open one's card to see what it did. Pick a
  faster model for them in Settings → Model, or per agent with `model:`.
- **More packages in the terminal**: `pkg search`, `pkg info`, and installs
  of WebAssembly, JavaScript and script packages from package indexes, each
  file checked; `pkg update`, `upgrade`, `verify`, `why`, and Tab completion.
  Put your own commands in `~/.local/bin`.
- The first packages to install that way: `qjs` (QuickJS), `rg` (ripgrep),
  `prettier`, `marked` (Markdown to HTML) and `yaml2json` / `json2yaml`.
- WebAssembly programs can read and write files in the folder they run in.
- **Notifications while you are away**: an approval or a question waiting,
  and a chat finished (with its last words); click one to open that chat.
- **Share a screen** (+ in the message box): one picture of a screen,
  window or tab, attached for the agent to see.
- **Passkeys**: sign in to a password-protected profile with your
  fingerprint, face, phone or security key (Settings → Profile).
- **Built into the browser**: Chrome's on-device model as a fourth model
  source (Settings → Model), where the browser has it.
- System → Capabilities says honestly what BrowserBox uses each feature for,
  and which are available but not used yet.
- **Settings → Packages**: search, install, remove, update and verify
  packages, and manage package sources, without the terminal.
- **Installed app**: open files from your computer with BrowserBox, share
  text, links and files to it from other apps, see how many chats wait for
  you on its icon, use its shortcuts, and get reminders of scheduled tasks
  due while it is closed.
- **Share** artifacts and files to other apps (Web Share).
- **Mini window** (⋯ → Mini window): follow the agent on top of other apps
  and answer approvals there.
- **Voice notes** (+ → Record a voice note), with a transcript.
- **Settings → Devices**: connect serial devices (Arduino, ESP32, …) for the
  new `serial` command, and send a folder straight to another device's
  BrowserBox with a pair of codes (WebRTC, no server).
- Fixed: a chat waiting for your approval now shows as waiting (amber) in
  the chat list.
- Fixed: the chat stops following new output only when you scroll up (a
  tall tool card or diff no longer stops it).
- Tool inputs show text as written (a file's content, code), not as escaped
  JSON.

## 0.3.2

Agent fixes (agent 0.3.1):

- Two edits of one file in the same step no longer undo each other.
- Downloads by the agent stay in its folder; deleting its whole folder,
  saved chats, skills or memory asks first; plan mode changes nothing.
- A model or instructions change applies to running chats.
- OpenAI-compatible APIs: token counts are shown, cut-off tool calls are
  not run, and no tool calls are lost.

## 0.3.1

- **Profiles in the Terminal**: `profile`, `profile list | new | switch |
  rename | delete`, `passwd`, `signout` (or `logout`), and `exit` to close
  the terminal. The prompt shows your profile (`jeevan@bbx`). Only you, typing
  in a terminal, can change profiles; the agent cannot.

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
