# Working with the agent

## Modes

The chip next to **+** sets how the agent works on your next message. **Shift+Tab** switches between them.

- **Ask first**: the agent asks before it changes files outside its own folder, runs commands or code, or uses the network. You can allow once or always.
- **Accept edits**: file changes go through without asking (except in folders you shared from your computer, under `/mnt`); running commands and code, the network and system actions still ask. Undo in **Changes** puts files back.
- **Plan**: the agent only looks (reads files, searches), then replies with a numbered plan. Choose **Run the plan** to have it carry the plan out, or keep refining it.
- **Auto**: the agent acts without asking. Everything still happens inside the sandbox.

The agent reads a file before it changes it. If you edit a file while it works, its next edit of that file is refused until it reads your version, so your change is kept.

## Permission rules

**Settings → Permissions → Rules** fine-tunes the mode for particular commands, paths, URLs or tools. Each rule is **Allow** (no prompt), **Always ask** (a prompt even in Auto) or **Never allow** (blocked even in Auto). For example:

- Allow command `git *` and `ls *`: everyday commands run without a prompt.
- Always ask for URL `https://api.github.com/*`.
- Never allow command `rm -rf *`, or path `/home/user/private/*`.

`*` matches anything, and `git *` also matches plain `git`. Never allow wins over Always ask, which wins over Allow. A command line joined with `&&`, `;` or `|` is allowed only when every command in it is; one that runs `$(…)` or backticks always needs your OK.

## Seeing and undoing changes

- Every file the agent writes or edits shows its **diff** in the chat.
- **"N files changed · Review"** above the message box opens **Changes**: each file compared with how it was before this chat, with **Open**, **Undo** and **Undo all**.
- **Edit** (on hover, or tap on phones) on one of your messages goes back to that point. If the agent changed files since, you choose whether to undo those changes too. Then edit and resend.

Only changes made with the agent's file tools are tracked. Changes made by shell commands or scripts are not.

## While it works

- Keep typing: messages **queue** above the box and are sent when the agent finishes. **Send now** stops it and sends them.
- **Esc** stops the agent.
- Switch to another chat at any time: the first keeps working. In the chat list, a pulsing dot means working and an amber dot means it is waiting for you.
- **Away from the window?** If you allow notifications (Settings → Permissions), BrowserBox tells you when the agent needs an approval or asks a question, and when a chat finishes. Click the notification to go to that chat.
- **Mini window** (⋯ → Mini window, in Chrome and Edge): a small window that stays on top of other apps and shows what the agent is doing; approvals can be answered right there.

## Projects

Each project has its own folder, chats, memory and instructions. Pick one at the top of the sidebar, or **New project…** to make one: give it a name and a folder (a new one under `~/Projects`, an existing one, or a folder you shared from your computer under `/mnt`). In a project the agent works in its folder, changes files there without asking (in Ask mode, elsewhere still asks), and reads the folder's `AGENTS.md`. **Project settings…** edits the instructions, sets a default model and pins knowledge files the agent always gets. **General** is the original workspace, `/home/agent`, with every chat from before projects. Deleting a project deletes its chats and memory; its folder is kept unless you tick the box.

### Interactive replies

When a picture or a click says it better than prose, the agent answers with UI inside its reply: figures and charts, a table you can sort, progress and checklists, buttons, choices and short forms. Picking a choice or sending a form answers the agent for you, as your next message; links open web pages, files of the box (an `.html` file in Preview) or apps. Old chats draw their UI again when you open them.

### Tabs of their own

Any tool can have a browser tab to itself: **Open in new tab** on a desktop window's title bar, on the agent window's side panel, and on an artifact. The tab uses the same kernel as your other windows (same files, dev servers and settings), and its address keeps what it shows, so a reload or a copied link opens the same page, file or artifact.

### Isolated chats

Type `/isolate` (or **Work on a copy** in the chat menu) and the chat works on its own copy of the project folder, at `/work/<chat>`: its edits, shell commands, dev servers and previews all use the copy, and the folder itself does not change. Nothing is copied up front; only the files it changes are kept, with the chat. **"Copy: N files to apply · Review"** above the message box shows each added, changed or deleted file against the folder, with **Apply** and **Discard** for one file or all of them. Several chats can work on the same project this way without getting in each other's way. `/isolate off` goes back to the folder itself once nothing is left to apply.

## Artifacts

When the agent makes something worth keeping (a document, a web page or small app, a diagram, an SVG, a table, some code) it makes an **artifact**: a card in the chat that opens it beside the conversation. Each change is a new version you can switch between. **Edit** opens a copy as a new version in the Editor; **Copy** and **Download** take it elsewhere. **Artifacts** in the side panel (and on the desktop) lists every artifact in the project. They are files in the project's `.artifacts` folder, so undo and rewinding a chat cover them too. Pages and diagrams run sandboxed: they cannot reach your files, keys or other sites.

## Memory

The agent remembers things between chats: about you (everywhere) and about the current project. It saves a fact when it learns something that will matter later; each one shows in the chat and can be undone. Type `/remember <fact>` (or `/remember me: <fact>` for everywhere) and `/forget <text>` yourself, and see or edit everything in **Settings → Memory**, where you can also stop the agent saving memories itself. New memories apply from the next chat.

## Scheduled tasks

**Settings → Scheduled** (or `/schedule <prompt>`) runs a prompt on a schedule: every few minutes (at least 15), every hour, every day, on weekdays or weekly, in a project you choose. Each run is a chat titled "⏱ name · date", so its result is in your chat list, and you can be notified when it finishes. Nobody is there to approve during a run, so you choose up front whether it may change files, run commands and code, or use the network; anything else is refused. **Run now**, **Pause** and **Edit** are next to each task.

Tasks run only while BrowserBox is open in some window or tab: a browser cannot wake a closed web page. If BrowserBox was closed at the time, the task runs as soon as it opens again, or skips that run, as you choose.

## Giving it context

- **@** picks a file from the agent's folder; its contents go with your message.
- **+ → Attach files** adds files from your device to the chat. They are kept with the chat (in `/home/agent/.sessions/<chat>/files`), the agent reads them from there, and deleting the chat deletes them; a private chat's go when it ends. You can also paste a screenshot into the message box, or use **+ → Share a screen**: pick a screen, window or tab and one picture of it is attached (nothing is recorded or shared after that). **+ → Record a voice note** attaches an audio recording and, where the browser can recognise speech, writes its transcript into the message (most models cannot listen to audio themselves).
- **Images** (PNG, JPEG, GIF or WebP, up to 5 MB) that you attach or @mention are shown to the model, which can also look at image files itself (`view_image`). This needs a model that can see images: Claude, GPT and other vision models do; the small in-browser models do not.
- **AGENTS.md** in `/home/agent` is read at the start of every chat: put how your project is built, tested and laid out there. `/init` has the agent write it.
- **MEMORY.md** in `/home/agent` is the agent's long-term notes about you and your work.

## Commands

Type **/** in the message box: `/plan`, `/changes`, `/isolate`, `/init`, `/compact` (summarise the chat to free context), `/context`, `/clear` (new chat), `/skills`, `/agents`, `/connectors`, `/model`, `/help`, plus your own commands from `/home/agent/commands`.

## Context, tokens and speed

Each reply ends with its time, speed (tokens per second), tokens written and the context size. The gauge next to the model shows how full the context window is; open it to see what fills it and this chat's totals. When it is nearly full the conversation is summarised automatically (APIs and servers), or the oldest messages drop out of view (small in-browser models).

## Private chats

The ghost icon on a new chat starts a **private chat**: it is not saved, not listed, and gone when you leave it.

## Extending the agent

- **Skills** (Settings → Skills): instructions for specific kinds of task, used when a request matches.
- **Agents** (Settings → Agents): specialised sub-agents with their own role, tools and optionally model (`model:` in the file), which the agent can delegate to. Several sub-agents run at once; open a sub-agent's card and choose **Show what it did** to read its work. Settings → Model → **Model for sub-agents** picks a cheaper, faster model for all of them.
- **Connectors** (Settings → Connectors): MCP servers that add tools.
- **Hooks** (Settings → Hooks): commands that run at points in the agent's work, without asking: before or after a tool (for example check every edited file), when you send a message, when a chat starts, and when the agent is done (exit 2 sends it back to work, for example when tests fail). In a hook, `$BBX_TOOL`, `$BBX_FILE` and `$BBX_EVENT` are replaced by the details, and `$BBX_INPUT` by a JSON file with all of them. Exit 2 blocks, with the hook's output as the reason. Each run shows as a line in the chat. The agent cannot change hooks.
- **Environment** (Settings → Environment): variables available to the shell, JavaScript and Python.
