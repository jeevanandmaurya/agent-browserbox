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

## Python and pip

`python script.py`, `python -c "…"`, `python -m pip …`. `pip install` adds pure-Python packages from PyPI and the packages Pyodide builds for the browser (numpy, pandas, scipy, matplotlib, scikit-learn and more). Packages with other compiled code cannot install. Installed packages are remembered and reinstalled when Python restarts.

## Files

The file system is private to this browser. `/home/user` is yours, `/home/agent` is the agent's working folder, `/tmp` is cleared on reload, and `/proc` shows live system state. Folders you share from your computer (Files → Mount) appear under `/mnt`.
