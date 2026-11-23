# Working with the agent

## Modes

The chip next to **+** sets how the agent works on your next message. **Shift+Tab** switches between them.

- **Ask first**: the agent asks before it changes files outside its own folder, runs commands or code, or uses the network. You can allow once or always.
- **Plan**: the agent only looks (reads files, searches), then replies with a numbered plan. Choose **Run the plan** to have it carry the plan out, or keep refining it.
- **Auto**: the agent acts without asking. Everything still happens inside the sandbox.

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
- **Agents** (Settings → Agents): specialised sub-agents with their own role and tools, which the agent can delegate to.
- **Connectors** (Settings → Connectors): MCP servers that add tools.
- **Environment** (Settings → Environment): variables available to the shell, JavaScript and Python.
