# Plan: the agent's next features (0.4)

Status: Phase 1 done (agent, runtime and app 0.4.0). Decisions 10.2–10.5 use
the proposals below unless changed. Written after the agent review (agent 0.3.1).
Covers the gaps against Claude Code (an agent working on code) and the Claude
desktop app (projects, artifacts, memory, scheduled work), designed for what
BrowserBox actually is: everything runs in one browser tab, per profile, with
no server.

Contents

1. Principles that apply to every feature
2. Phase 1: safer, faster edits (read-before-edit, accept-edits mode, parallel sub-agents, a model per agent)
3. Phase 2: hooks
4. Phase 3: projects and memory
5. Phase 4: artifacts
6. Phase 5: scheduled tasks
7. Later: background commands, nested AGENTS.md, web search with any model
8. Versions, releases and migration
9. Testing
10. Decisions needed before starting

---

## 1. Principles

- **Where code lives.** Behaviour the agent has belongs in `packages/agent`
  (any app built on it gets it). Storage and permissions the box enforces
  belong in `packages/runtime`. Screens belong in `apps/browserbox`. The app
  keeps using only released packages.
- **Files first.** New state the user might want to see, edit, back up or
  version (artifacts, memory, project instructions) is stored as files in the
  box, so the file tools, undo/rewind, export and git all work on it for free.
  State that must not be edited by the agent (hooks, schedules, permission
  rules) lives in settings, which the agent has no tool to change.
- **The agent never gains power from its own output.** Nothing the agent can
  write (files, artifacts, memory) may later run commands or loosen
  permissions without a person acting. This rules out hooks or schedules
  stored as files.
- **Honest about the platform.** No feature promises what a browser tab cannot
  do (for example, running while every BrowserBox tab is closed).
- **Each phase ships on its own** with tests, docs and a changelog entry, and
  leaves nothing half-built.

---

## 2. Phase 1: safer, faster edits

### 2.1 Read before edit, and stale-file detection

**Problem.** `edit_file` and `write_file` change files the agent has never
read, or read long ago. If the user edited the file in the Editor, or a shell
command changed it, the agent overwrites that work without knowing. Claude
Code refuses both.

**Behaviour.**
- Editing or overwriting an existing file requires that the agent read it (or
  wrote it) earlier in this session. Otherwise the tool fails with: "Read
  <path> first: you have not seen its current content."
- If the file changed since the agent last read or wrote it, the tool fails
  with: "<path> changed since you read it (by you, the user, or a command).
  Read it again before editing." The model re-reads and retries.
- Creating a new file needs no read.
- `read_file` with offset/limit counts as a read (as in Claude Code).

**Design.**
- `Agent` keeps `#seen: Map<string, { hash: string; size: number }>` (path is
  absolute). A cheap content hash from the kernel core (`kcore` already hashes
  in WebAssembly); fall back to size + a JS FNV hash.
- `ToolContext` gains `seen: { note(path, bytes): void; check(path): Promise<void>; forget(path): void }`.
- `read_file`, `write_file`, `edit_file` call `note` after they succeed
  (with the bytes they read or wrote). `edit_file`/`write_file` call `check`
  first when the file exists. `move_path` moves the entry; `delete_path`
  forgets it.
- The map is cleared after compaction: the summary no longer holds the file
  contents, so editing from memory is exactly the mistake this prevents.
- Sub-agents have their own map (they start with no knowledge).
- Not persisted: a resumed session must read again (Claude Code does the same).

**Edge cases.** Binary files (`write_file` only creates/overwrites; a
binary target needs a prior read too). Files over the read limit (2,000
lines): a partial read still counts. Files changed by the agent's own shell
commands: the hash differs, so it must re-read, which is correct.

**Tests.** Edit without read fails; read then edit works; user change
between read and edit fails, re-read fixes it; new file needs no read;
compaction forgets; sub-agent is independent.

### 2.2 "Accept edits" permission mode

**Problem.** Today the choice is Ask (every edit outside the workspace,
every command) or Auto (nothing asked). Claude Code's most used mode is in
between: file edits go through, commands and network still ask.

**Behaviour.** A fourth mode in the composer chip (Shift+Tab cycles):
Ask · **Accept edits** · Plan · Auto, and in Settings → Permissions.
In Accept edits:
- File tools (write, edit, move, delete) are allowed anywhere in the box
  except under `/mnt` (the user's real folders), which still ask.
- Shell commands, code, network and system actions ask as in Ask mode.
- Permission rules still come first (a deny rule still blocks).

**Design.**
- `PermMode` becomes `'ask' | 'edits' | 'auto'`, in both the runtime's
  `Permissions` (packages/runtime/src/kernel/perms.ts) and the agent's
  (packages/agent/src/host/perms.ts). The runtime treats `edits` like `ask`
  for its own checks (`curl`, `js --net` inside shells), which is the point:
  commands keep asking.
- The agent loop decides edits: if mode is `edits`, the cap is `fs.write`,
  and none of the changed paths is under `/mnt`, it is allowed without a
  prompt.
- Older code reading `perms.mode` sees an unknown value: the runtime maps
  anything it does not know to `ask` (safe default).

**Tests.** Edits outside the workspace pass without a prompt in edits mode;
`/mnt` writes prompt; shell prompts; deny rules still block; Shift+Tab cycle.

### 2.3 Parallel sub-agents

**Problem.** Several `spawn_agent` calls in one turn run one after another;
three explorations take three times as long. Claude Code runs them at once.

**Behaviour.** Sub-agents requested in the same turn run concurrently (at
most 4; more wait for a slot). Each shows its own progress card. Stopping the
parent stops all of them.

**Design.**
- `#runTools` groups calls: consecutive `spawn_agent` calls form a batch run
  with `Promise.all` and a small semaphore; everything else keeps its order.
- Write conflicts between children are caught by 2.1 (a child editing a
  file another child changed gets the "changed since you read it" error and
  re-reads), so concurrency is safe without locks. This is why 2.1 comes
  first.
- Permission prompts from several children can be pending at once; the
  approval cards already carry their own request, so each is answered on its
  own. In a headless host, the prompter queue serialises them.
- Each child's transcript is kept with the parent session
  (`SessionFile.subagents[toolCallId] = Msg[]`) so the user can expand a
  sub-agent card and read what it did. Capped at the last 200 messages each.

### 2.4 A model per agent

**Behaviour.** Custom agents can name a model in their front matter
(`model: claude-haiku-5-5`), and Settings → Model gains "Model for
sub-agents" (default: same as main). Typical use: a fast, cheap model for
an `explorer` agent.

**Design.**
- Resolution: agent front matter `model` → setting `subagentModel` → main
  model. Only the model id changes; the provider (API address and key) is the
  main one's. A model id the API rejects fails the sub-agent with the API's
  message, not the parent.
- `createProvider(os, cfg)` is called with `{ ...cfg, apiModel }` for the
  child. For local and WebGPU providers the setting is ignored (one model).

### 2.5 Also in Phase 1

- System prompt: correct the stale `run_js` timeout text ("30 s by default,
  up to 5 min with timeout_ms" became a fixed 2 minutes in 0.3.1).

---

## 3. Phase 2: hooks

**What.** Commands the user configures that run at points in the agent's
work, as in Claude Code: format a file after every edit, block a command,
run the tests when the agent says it is done.

**Events.**

| Event | When | Can it change what happens? |
|---|---|---|
| `PreToolUse` | before a tool runs (after permission) | yes: block it with a reason the model sees |
| `PostToolUse` | after a tool succeeds | yes: add text to the tool result (e.g. lint errors) |
| `UserPromptSubmit` | when the user sends a message | yes: add context, or block the message |
| `Stop` | when the agent is about to finish | yes: tell it to keep going (e.g. "tests fail: …") |
| `SubagentStop` | when a sub-agent finishes | yes, as Stop |
| `SessionStart` | when a chat starts or resumes | add context |

**Configuration.** Settings → Hooks: a list of `{ event, matcher, command,
timeout, enabled }`. The matcher is a tool name or glob (`edit_file|write_file`,
`shell`, `*`) for tool events. Stored in the setting `agent.hooks`, never in
a file: the agent has no tool to change settings, so it cannot give itself
hooks (principle 3).

**Running a hook.**
- The command runs in the BrowserBox shell, in the agent's working folder,
  with a 60-second default timeout, in a shell of its own (not the agent's,
  so `cd` in a hook does not move the agent).
- Input arrives as JSON on stdin: `{ event, session, tool, input, result }`
  and as environment variables (`$BBX_TOOL`, `$BBX_FILE` for file tools).
- Exit codes, as in Claude Code: `0` success (stdout is added for
  `PostToolUse`/`SessionStart`/`UserPromptSubmit`, shown to the user for
  others); `2` block (stderr goes to the model as the reason); anything else
  is a hook error, shown to the user, not the model, and the work continues.
- Hooks run without permission prompts (the user wrote them), but each run
  shows in the chat as a small "hook: <command>" line, so nothing is hidden.
- A `Stop` hook that keeps saying "continue" is limited to 3 rounds per user
  message, then the agent stops with a note.

**Examples shipped in the docs.** Prettier-style formatting after edits
(once a formatter package exists), blocking `rm -rf` outside `/tmp`, running
`npm test` equivalents through `build`, notifying on stop.

**Tests.** Each event; exit 0/2/other; timeout; matcher; Stop loop limit;
the agent cannot read or write `agent.hooks`.

---

## 4. Phase 3: projects and memory

### 4.1 Projects

**What.** Separate workspaces, like projects in the Claude app and folders in
Claude Code: each has its own folder, instructions, chats and memory.
Switch between them in the sidebar.

**Model.**

```
Project {
  id: string           // "general" for the existing workspace
  name: string
  folder: string       // /home/agent for General; default /home/user/Projects/<name>
  created: number
  model?: string       // optional default model for its chats
}
```

- Stored in the setting `agent.projects` (per profile, synced across windows).
- **General** is the existing `/home/agent` workspace. Every existing chat
  belongs to it: no migration.
- A project's folder can be a new folder, an existing one, or a real folder
  shared under `/mnt` (work on a real repository; writes there always ask,
  see 2.2).

**What changes for the agent.**
- Its working folder (`cwd`, and the "free to write" area that replaces
  `AGENT_HOME` in `writeCap`) is the project folder. Introduce
  `Agent.workspace` and pass it through `ToolContext`; remove the remaining
  hard-coded `AGENT_HOME` uses in tools and prompt.
- Instructions: `AGENTS.md` (or `CLAUDE.md`) in the project folder.
- Knowledge: files the user pins in project settings are put in the system
  prompt up to a budget (20,000 tokens); the rest are listed by path for
  `read_file`.
- The agent's own records never go inside the project folder (it may be a
  git repository the user pushes): chats stay in `/home/agent/.sessions`
  with a `project` field, memory in `/home/agent/.memory/<project>.md`.
- Skills, custom agents and commands stay global (per profile) in v1.

**Sessions index.** `listSessions` parses every session file to show the
list, which gets slow with hundreds of chats and many projects. Add
`/home/agent/.sessions/index.json` (`{ id, title, updated, project }[]`),
updated on save/delete and rebuilt from the files when missing or invalid.

**Screens.**
- Sidebar: a project picker above "New chat" (General ▾), listing projects,
  "New project…", "Project settings…". The chat list shows that project's
  chats.
- New project dialog: name; folder (new, choose existing, or a mounted
  folder); optional instructions (written to AGENTS.md).
- Project settings: name, folder, instructions, pinned knowledge files,
  default model, delete project (removes the project and its chats; the
  folder is kept unless the user also ticks "delete its folder").
- Terminal, Files and Editor open in the project folder.

**Tests.** Existing chats appear under General; a new project's chats are
separate; agent writes inside the project are free, outside ask; AGENTS.md
from the project folder; index rebuilt after deleting it; deleting a project
keeps the folder by default.

### 4.2 Memory

**Today.** `/home/agent/MEMORY.md` goes into the system prompt (first 6,000
characters) and the agent may edit it with the file tools. In practice it
rarely does, it can rewrite and lose the whole file, and nothing shows the
user what was remembered.

**Behaviour.**
- Two scopes: **about you** (profile-wide) and **this project**.
- A `memory` tool with actions `view`, `add`, `replace`, `remove`, working on
  single entries (one fact per line, with the date added). The model no
  longer rewrites the file, so entries cannot be lost by accident.
- The agent saves things worth remembering on its own (stated preferences,
  how the project builds, decisions), and each save shows in the chat as
  "Remembered: <fact>" with Undo.
- `/remember <fact>` and `/forget <text>` for the user.
- Settings → Memory: view, edit and delete entries for both scopes; a switch
  "Let the agent save memories" (on by default); "Clear all".
- When a scope grows past its budget (6,000 characters), the tool refuses to
  add and asks the model to consolidate (merge or drop entries) first.

**Design.**
- Files: profile memory stays `/home/agent/MEMORY.md` (compatible);
  project memory is `/home/agent/.memory/<projectId>.md`. Plain Markdown
  list items, editable by hand.
- The prompt takes a snapshot at the start of each session, as today (so the
  prompt cache is not broken mid-chat); new memories apply from the next chat,
  and the tool tells the model they are saved.
- Memory is per profile automatically (each profile has its own kernel).
- Undo in the chat uses the existing checkpoint mechanism (the memory file is
  a file).

**Tests.** add/replace/remove; budget refusal; undo; switch off stops
auto-saving but `/remember` still works; project vs profile scope.

---

## 5. Phase 4: artifacts

**What.** Things the agent makes for you to keep, as in the Claude app: a
document, a web page or small app, a diagram, an SVG, a table. They open in a
side panel, have versions, and can be edited, downloaded, published and
reopened later from any chat in the project.

**Difference from today.** `show_html` shows a page once in Preview and
forgets it. Artifacts are kept, versioned and linked to the chat that made
them. `show_html` stays for throwaway previews; the prompt steers the model to
artifacts for anything the user may want to keep.

**Kinds (v1).** `html` (page or app; runs sandboxed), `markdown`, `svg`,
`mermaid` (diagram), `code` (any language, with syntax highlighting),
`csv` (shown as a sortable table).

**Tools.**
- `create_artifact { title, kind, content }` → id and version 1.
- `update_artifact { id, edits: [{ old, new }] }` or `{ id, content }` →
  next version. Edits avoid resending a whole document.
- `read_artifact { id, version? }`.

**Storage (files, principle 2).**

```
<project folder>/.artifacts/<slug>/
  artifact.json   { id, title, kind, created, session, versions: [{ n, at, note }] }
  v1.html
  v2.html
```

Kept in the project's agent records instead if the project folder is a git
repository the user pushes (decision 10.3). Being files, artifacts are
covered by undo and rewind: rewinding a chat removes versions made after that
point.

**Screens.**
- In the chat: an artifact card (icon, title, kind, version) instead of a
  tool card; click opens it.
- Side panel "Artifact" tab: the rendered artifact; version switcher;
  actions Edit (opens in the Editor; saving makes a new version), Copy,
  Download, Open in a new tab, Publish (through the existing deploy tool,
  HTML only), Delete.
- An "Artifacts" list per project (workbench tab), newest first, with search.

**Rendering and safety.**
- HTML runs in the existing preview frame: an opaque origin with no access to
  BrowserBox storage, keys or other sites' cookies. Network only to servers
  that allow it (CORS), as for any page.
- Markdown uses the app's renderer (already sanitised). Mermaid loads its
  library on first use from a pinned CDN version. SVG is shown as an image
  (`<img>`), so scripts inside it never run.
- Size cap per version: 2 MB.

**Tests.** Create, update by edits, version switch, rewind removes later
versions, HTML sandbox cannot read the parent, SVG scripts do not run,
download, publish (with a mocked host).

---

## 6. Phase 5: scheduled tasks

**What.** "Every weekday at 8:00, summarise new issues in my repo"; "every
hour, check the build". As in the desktop app, within what a browser allows.

**The platform limit, stated in the product.** An agent can only run while a
BrowserBox tab of that profile is open. Browsers offer no reliable way to wake
a closed web app (periodic background sync is Chromium-only, for installed
apps, at most a few times a day, and cannot run the agent). So:
- While any BrowserBox tab is open, tasks run on time.
- When it was closed at the scheduled time, each task chooses: **run when
  BrowserBox next opens** (default) or **skip missed runs**.
- The task screen says this plainly, and suggests installing BrowserBox as an
  app and keeping a window open for frequent tasks.

**Model.**

```
ScheduledTask {
  id, name, prompt
  schedule: { every: 'hour' | 'day' | 'weekday' | 'week'; at?: 'HH:MM'; day?: 0-6 }
           | { everyMinutes: number }          // at least 15
  project: string                                // where it runs
  allow: { edits: boolean; commands: boolean; network: boolean }
  missed: 'run' | 'skip'
  notify: boolean
  enabled: boolean
  lastRun?: { at, sessionId, outcome: 'ok' | 'error' | 'skipped', note }
  nextRun: number
}
```

Stored in the setting `agent.schedules` (never a file: principle 3).

**Running.**
- The scheduler lives in the profile's agent worker (one SharedWorker per
  profile, so one scheduler; where SharedWorker is missing, a Web Lock
  `bbx-schedule-<id>` makes sure only one window runs a task).
- It checks every 30 seconds; a due task starts a normal chat in its project
  titled "⏱ <name> · <date>", so results are in the chat list like any other.
- Unattended runs cannot ask: permissions are what the task allows (`allow`).
  A request outside that is denied with "not allowed for scheduled runs" and
  the run continues. Permission rules still apply.
- One run per task at a time; at most 2 tasks at once; a run stops after 30
  minutes or the step limit.
- A signed-out profile (locked keys) skips the run and records why.
- When done: a notification (if allowed) with the first lines of the result;
  clicking it opens the chat.

**Screens.** Settings → Scheduled (also a sidebar entry): create/edit (name,
prompt, schedule, project, permissions, missed runs, notify), list with next
run and last result, Run now, Pause, Delete. `/schedule` opens the editor
with the current message as the prompt. The agent can propose a task, but the
user creates it (no tool writes `agent.schedules`).

**Tests.** Next-run calculation (including DST changes and "weekday"),
missed-run policies, single runner across two windows, permission limits,
locked profile skip, notification.

---

## 7. Later

- **Background commands.** `shell` with `background: true` starts a job and
  returns at once; `job_output { id }` reads new output; `job_stop`. The
  dev server already covers the common case (servers).
- **Nested AGENTS.md.** When the agent works in a subfolder that has its own
  `AGENTS.md`, include it (as Claude Code does with `CLAUDE.md` per folder).
- **Web search and fetch with any model.** Needs a search API that allows
  browser requests and a key from the user (for example a Tavily or Brave key
  in Settings → Accounts), and page fetching through the relay. Today only
  Anthropic's server-side tools offer it.
- **Acting in the user's browser** (as Claude in Chrome does) is out of reach
  for a web page and is not planned.

---

## 8. Versions, releases and migration

| Phase | Agent | Runtime + SDK | App |
|---|---|---|---|
| 1 | 0.4.0 (modes, tool behaviour) | 0.4.0 (PermMode gains `edits`) | 0.4.0 |
| 2 | 0.4.x (adds hooks) | — | 0.4.x |
| 3 | 0.5.0 (workspace per project changes `ToolContext`) | — | 0.5.0 |
| 4 | 0.5.x | — | 0.5.x |
| 5 | 0.5.x | — | 0.5.x |

No user data moves: existing chats belong to General, `MEMORY.md` stays the
profile memory, `perms.mode` values `ask`/`auto` keep their meaning.

---

## 9. Testing

- Unit tests with the scripted model in `tests/agent.test.ts` for every agent
  behaviour above (they run without a browser).
- A browser check per feature in `scripts/features.mjs` with the mock model
  server, as for profiles and permission rules.
- Every phase ends with the full gate: typecheck, unit tests, smoke and
  feature suites, the SDK end-to-end test, and a look at the live site after
  release.

---

## 10. Decisions needed before starting

1. **Order.** Proposed: Phase 1 → 2 → 3 → 4 → 5. Projects and artifacts are
   the most visible; hooks matter most to people doing real coding.
2. **Accept edits outside `/home`.** Proposed: allowed anywhere in the box
   except `/mnt`. Alternative: only inside the current project folder.
3. **Artifacts inside project folders.** Proposed: in `<project>/.artifacts`
   so they travel with the project; alternative: in the agent's records, so
   they never end up in a git push.
4. **Automatic memory.** Proposed: on by default, every save visible with
   Undo. Alternative: off by default, `/remember` only.
5. **Scheduled tasks.** Is "runs only while a BrowserBox tab is open, catches
   up when it opens" acceptable? If not, this phase needs a server, which
   BrowserBox deliberately does not have.
