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

## Projects

Each project has its own folder, chats, memory and instructions. Pick one at the top of the sidebar, or **New project…** to make one: give it a name and a folder (a new one under `~/Projects`, an existing one, or a folder you shared from your computer under `/mnt`). In a project the agent works in its folder, changes files there without asking (in Ask mode, elsewhere still asks), and reads the folder's `AGENTS.md`. **Project settings…** edits the instructions, sets a default model and pins knowledge files the agent always gets. **General** is the original workspace, `/home/agent`, with every chat from before projects. Deleting a project deletes its chats and memory; its folder is kept unless you tick the box.

## Memory

The agent remembers things between chats: about you (everywhere) and about the current project. It saves a fact when it learns something that will matter later; each one shows in the chat and can be undone. Type `/remember <fact>` (or `/remember me: <fact>` for everywhere) and `/forget <text>` yourself, and see or edit everything in **Settings → Memory**, where you can also stop the agent saving memories itself. New memories apply from the next chat.

## Giving it context

- **@** picks a file from the agent's folder; its contents go with your message.
- **+ → Attach files** uploads files from your device into `/home/agent/uploads`. You can also paste a screenshot into the message box.
- **Images** (PNG, JPEG, GIF or WebP, up to 5 MB) that you attach or @mention are shown to the model, which can also look at image files itself (`view_image`). This needs a model that can see images: Claude, GPT and other vision models do; the small in-browser models do not.
- **AGENTS.md** in `/home/agent` is read at the start of every chat: put how your project is built, tested and laid out there. `/init` has the agent write it.
- **MEMORY.md** in `/home/agent` is the agent's long-term notes about you and your work.

## Commands

Type **/** in the message box: `/plan`, `/changes`, `/init`, `/compact` (summarise the chat to free context), `/context`, `/clear` (new chat), `/skills`, `/agents`, `/connectors`, `/model`, `/help`, plus your own commands from `/home/agent/commands`.

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
