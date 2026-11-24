# Terminal and packages

The Terminal runs BrowserBox's own shell. It works like a Unix shell for everyday use: pipes (`|`), redirects (`>`, `>>`), `&&`, `||`, `;`, `$VARIABLES`, wildcards, history (↑) and Tab completion. It is not bash: there are no loops, functions, `$(…)` or background jobs. Type `help` to list the commands by section; `help <command>` shows how to use one, and `help <section>` (`files`, `text`, `code`, `web`, `ai`, `packages`, `devices`, `you`, `system`) lists one section.

## Packages

Optional software is installed with `pkg`:

- `pkg list` shows what exists, what is installed and the download sizes
- `pkg install python`, `pkg remove zip`

Typing a command from a package that is not installed tells you which package to install. Installed packages work offline.

| Package | Gives you |
| --- | --- |
| python | Python 3.13 (Pyodide) with `pip` |
| git | `git` (local repositories; see [Shipping](shipping) for GitHub) |
| sqlite | `sqlite3` |
| zip | `zip`, `unzip` |
| esbuild | the bundler behind `serve` and `build` (installed when first needed) |
| node | real Node.js and npm (see [Advanced](advanced)) |

### More packages

Besides the built-in packages above, `pkg` installs programs described by a package index: WebAssembly programs (WASI), JavaScript programs and shell scripts. Each file is checked against the sha256 its index lists before it is kept.

| Command | Does |
| --- | --- |
| `pkg search <text>` | search every index |
| `pkg info <id>` | version, size, commands, dependencies, where it comes from |
| `pkg install <id>[@version]` | install it and what it depends on |
| `pkg install <url>` | install one package from its `bbx-package.json` (asks every time) |
| `pkg remove <id>` | remove it (refused while another package needs it; `--force`) |
| `pkg update`, `pkg upgrade` | refresh the indexes; install newer versions |
| `pkg files <id>`, `pkg verify` | list its files; check them all again |
| `pkg why <id>` | which packages need it |
| `pkg source list`, `add <url>`, `remove <url>` | the indexes `pkg` uses |

The official index has:

| Package | Gives you |
| --- | --- |
| quickjs | `qjs`, a small JavaScript interpreter (QuickJS-ng) |
| ripgrep | `rg`, fast search through files |
| prettier | `prettier` to format JS, TS, CSS, JSON, Markdown, HTML, YAML (`--write`, `--check`) |
| marked | `marked notes.md -o notes.html --page`: Markdown to HTML |
| yaml | `yaml2json`, `json2yaml` |

The official index installs without asking. Adding another index asks once; only a person typing in a terminal can confirm, so the agent and scripts install from the official index only.

JavaScript programs (`.js` in `~/.local/bin`, or a package) get `fs`, `print`, `console`, `args`, `env`, `stdin` and `exit(code)`.

Your own commands: put a `name`, `name.wasm`, `name.js` or `name.sh` file in `~/.local/bin` and type `name`. WebAssembly programs see the folder they run in, and can read, write, rename and delete files there (not above it).

## Profiles

| Command | Does |
| --- | --- |
| `profile` | who you are: the profile, and whether it has a password |
| `profile list` | every profile (`*` marks yours) |
| `profile new <name>` | make a profile |
| `profile switch <name>` | open another profile in this window |
| `profile rename <name>` | rename yours |
| `profile delete <name>` | delete another profile with its files, keys and chats (asks you to type its name) |
| `passwd`, `passwd -d` | set or change, or remove, your password |
| `signout` (or `logout`) | lock your API keys until the password is entered |
| `exit` | close this terminal |

Only a person typing in a terminal can change profiles: the agent and scripts can see who you are, but not switch, create, rename, delete, change the password or sign out.

## Projects, chats and the look

What the sidebar and Settings do, by typing (the agent can use these too):

| Command | Does |
| --- | --- |
| `project list`, `project show [id]` | your projects, or one in detail (folder, model, knowledge files, instructions) |
| `project new <name> [--folder /path]` | make a project |
| `project rename <id> <name>`, `project use <id>` | rename one; choose the one new chats and windows start in |
| `project knowledge <id> add <path>` | a file always given to the agent in that project (`remove` takes it off) |
| `chats [list]`, `chats search <words>` | saved chats, newest first; search titles and what was said |
| `chats show <id>`, `chats export <id> [file.md]` | read a chat, or save it as Markdown |
| `theme list`, `theme set <name>` | the themes; use one (`system` follows your device) |
| `theme wallpaper [style]` | the wallpaper styles; use one (`theme` = the theme's own) |

Deleting a project (`project delete`) or a chat (`chats delete`) asks you to confirm, and only a person typing in a terminal can do it.

## Serial devices

Microcontrollers (Arduino, ESP32, Raspberry Pi Pico), modems and instruments connected by USB serial, in Chrome, Edge and Opera on a computer. Connect a device once in **Settings → Devices** (the browser asks you to pick it); then:

| Command | Does |
| --- | --- |
| `serial list` | the connected devices, numbered |
| `serial open 0 --baud 9600` | open device 0 (115200 baud unless you say) |
| `serial send 0 AT` | send a line (`\r\n` added; `--raw` sends exactly what you typed; `\n`, `\xHH` work) |
| `serial read 0 --ms 2000` | print what arrived, waiting up to 2 s |
| `serial monitor 0` | print everything it sends until Ctrl+C |
| `serial close 0` | close it |

The agent can use these too, with your approval of each command. Settings → Devices also has a small monitor.

## Python and pip

`python script.py`, `python -c "…"`, `python -m pip …`. `pip install` adds pure-Python packages from PyPI and the packages Pyodide builds for the browser (numpy, pandas, scipy, matplotlib, scikit-learn and more). Packages with other compiled code cannot install. Installed packages are remembered and reinstalled when Python restarts.

## Files

The file system is private to this browser. `/home/user` is yours, `/home/agent` is the agent's working folder, `/tmp` is cleared on reload, and `/proc` shows live system state. Folders you share from your computer (Files → Mount) appear under `/mnt`.
