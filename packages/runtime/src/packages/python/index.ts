import { userEnv } from '../../shell/commands/exec';
import { PIP_KEY, runPython } from '../../sandbox/sandbox';
import type { Command, CommandContext } from '../../shell/shell';
import { flags } from '../../shell/shell';
import type { PackageModule } from '../types';

function finish(ctx: CommandContext, r: Awaited<ReturnType<typeof runPython>>): number {
  if (r.value !== undefined && r.value !== 'None') ctx.out(r.value + '\n');
  if (r.error) ctx.err(r.error + '\n');
  return r.ok ? 0 : 1;
}

const run = (ctx: CommandContext, code: string) => runPython(ctx.os, code, { cwd: ctx.shell.cwd, env: userEnv(ctx.shell.env), signal: ctx.signal, onStdout: ctx.out, onStderr: ctx.err });

const python: Command = {
  name: 'python',
  summary: 'run Python 3.13 (CPython on WebAssembly, via Pyodide)',
  usage: 'python file.py  |  python -c "code"  |  python -m pip install <pkg>  |  python -V   (files in the cwd are visible; changes are written back)',
  async run(ctx) {
    const { opts, rest } = flags(ctx.args);
    if (opts.has('V') || opts.has('version')) return finish(ctx, await run(ctx, 'import sys, pyodide\nprint(f"Python {sys.version.split()[0]} (Pyodide {pyodide.__version__})")'));
    if (opts.has('m')) {
      if (rest[0] === 'pip') return pip.run({ ...ctx, args: rest.slice(1) });
      return finish(ctx, await run(ctx, `import runpy, sys\nsys.argv = ${JSON.stringify(rest)}\nrunpy.run_module(${JSON.stringify(rest[0] ?? '')}, run_name="__main__")`));
    }
    const code = opts.has('c') ? (rest[0] ?? '') : rest[0] ? await ctx.os.fs.readText(ctx.path(rest[0])) : ctx.stdin;
    if (!code.trim()) throw new Error('nothing to run: pass a file, -c "code", or pipe code in');
    return finish(ctx, await run(ctx, code));
  },
};

/**
 * pip on top of micropip: pure-Python wheels from PyPI, plus the packages
 * Pyodide ships compiled for WebAssembly (numpy, pandas, scipy, scikit-learn…).
 * What you install is remembered and reinstalled in every new interpreter.
 */
const pip: Command = {
  name: 'pip',
  summary: 'install Python packages (PyPI pure-Python wheels and Pyodide builds) with micropip',
  usage: 'pip install <pkg>… | pip install -r requirements.txt | pip uninstall <pkg>… | pip list | pip show <pkg> | pip freeze',
  async run(ctx) {
    const [verb = 'help', ...args] = ctx.args;
    const saved = () => ctx.os.settings.get<string[]>(PIP_KEY, []);
    const base = (spec: string) => spec.split(/[<>=!~\[; ]/)[0]!.toLowerCase();
    if (verb === 'install') {
      const specs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '-r' || a === '--requirement') {
          const file = await ctx.os.fs.readText(ctx.path(args[++i] ?? ''));
          specs.push(...file.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-')));
        } else if (!a.startsWith('-')) specs.push(a);
      }
      if (!specs.length) throw new Error('usage: pip install <pkg>… | pip install -r requirements.txt');
      ctx.out(`Installing ${specs.join(', ')}…\n`);
      const r = await run(ctx, `import micropip\nawait micropip.install(${JSON.stringify(specs)}, keep_going=True)\ninstalled = micropip.list()\nfor s in ${JSON.stringify(specs.map(base))}:\n    p = installed.get(s) or installed.get(s.replace("_", "-"))\n    print(f"Successfully installed {s}-{p.version}" if p else f"{s}: installed")`);
      if (!r.ok) return finish(ctx, r);
      const keep = saved().filter((s) => !specs.some((n) => base(n) === base(s)));
      ctx.os.settings.set(PIP_KEY, [...keep, ...specs]);
      return finish(ctx, r);
    }
    if (verb === 'uninstall') {
      const names = args.filter((a) => !a.startsWith('-'));
      ctx.os.settings.set(PIP_KEY, saved().filter((s) => !names.some((n) => base(n) === base(s))));
      return finish(ctx, await run(ctx, `import micropip\nfor n in ${JSON.stringify(names)}:\n    try:\n        micropip.uninstall(n); print(f"Successfully uninstalled {n}")\n    except Exception as e:\n        print(f"{n}: {e}")`));
    }
    if (verb === 'list' || verb === 'freeze') {
      const line = verb === 'freeze' ? 'print(f"{name}=={p.version}")' : 'print(f"{name:<32} {p.version:<14} {p.source}")';
      return finish(ctx, await run(ctx, `import micropip\n${verb === 'list' ? 'print(f"{\'Package\':<32} {\'Version\':<14} Source")\n' : ''}for name, p in sorted(micropip.list().items()):\n    ${line}`));
    }
    if (verb === 'show') {
      return finish(ctx, await run(ctx, `import micropip\nfrom importlib import metadata\nfor n in ${JSON.stringify(args)}:\n    try:\n        m = metadata.metadata(n)\n        print(f"Name: {m['Name']}\\nVersion: {m['Version']}\\nSummary: {m.get('Summary', '')}\\nRequires: {', '.join(metadata.requires(n) or [])}\\n")\n    except metadata.PackageNotFoundError:\n        print(f"WARNING: Package(s) not found: {n}")`));
    }
    ctx.out(`${pip.usage}\n\nRuns micropip in the Python sandbox: pure-Python wheels from PyPI and Pyodide's WebAssembly builds (numpy, pandas, scipy, matplotlib, scikit-learn…). Packages with other C extensions cannot install. Installed packages are reinstalled in each new interpreter.\n`);
    return verb === 'help' ? 0 : 1;
  },
};

export default {
  commands: [python, { ...python, name: 'python3' }, pip, { ...pip, name: 'pip3' }],
} satisfies PackageModule;
