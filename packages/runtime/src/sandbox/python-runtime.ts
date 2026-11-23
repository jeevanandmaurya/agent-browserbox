/** Where the Python runtime comes from. Shared by the sandbox and the python package's manifest. */
export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';
export const PYTHON_RUNTIME_FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
/** Cache Storage bucket that holds installed packages' files. */
export const PACKAGE_CACHE = 'bbx-packs';
