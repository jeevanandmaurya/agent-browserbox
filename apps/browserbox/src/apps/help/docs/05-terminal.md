# Terminal and packages

The Terminal runs BrowserBox's own shell. It works like a Unix shell for everyday use: pipes (`|`), redirects (`>`, `>>`), `&&`, `||`, `;`, `$VARIABLES`, wildcards, history (↑) and Tab completion. It is not bash: there are no loops, functions, `$(…)` or background jobs. Type `help` to list the commands.

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

## Python and pip

`python script.py`, `python -c "…"`, `python -m pip …`. `pip install` adds pure-Python packages from PyPI and the packages Pyodide builds for the browser (numpy, pandas, scipy, matplotlib, scikit-learn and more). Packages with other compiled code cannot install. Installed packages are remembered and reinstalled when Python restarts.

## Files

The file system is private to this browser. `/home/user` is yours, `/home/agent` is the agent's working folder, `/tmp` is cleared on reload, and `/proc` shows live system state. Folders you share from your computer (Files → Mount) appear under `/mnt`.
