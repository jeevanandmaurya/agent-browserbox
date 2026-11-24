// prettier: formats files with Prettier (its standalone build and plugins).
const prettier = require('standalone.js');
const plugins = ['babel', 'estree', 'typescript', 'postcss', 'markdown', 'html', 'yaml', 'graphql'].map((p) => require(`plugins/${p}.js`));
const usage = `usage: prettier [--write | --check] [options] file...
  (no flag)          print the formatted file
  -w, --write        format the files in place
  -c, --check        list files that are not formatted (exit 1 if any)
  --parser NAME      babel, typescript, css, scss, less, json, markdown, html, vue, yaml, graphql
  --stdin-filepath F format stdin as if it were the file F
  --print-width N  --tab-width N  --use-tabs  --single-quote  --no-semi  --trailing-comma all|es5|none
Options also come from .prettierrc (JSON) in the folder.`;
const opts = {};
let mode = 'print';
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') return print(usage);
  else if (a === '-v' || a === '--version') return print(prettier.version);
  else if (a === '-w' || a === '--write') mode = 'write';
  else if (a === '-c' || a === '--check' || a === '-l' || a === '--list-different') mode = 'check';
  else if (a === '--parser') opts.parser = args[++i];
  else if (a === '--stdin-filepath') opts.filepath = args[++i];
  else if (a === '--print-width') opts.printWidth = Number(args[++i]);
  else if (a === '--tab-width') opts.tabWidth = Number(args[++i]);
  else if (a === '--use-tabs') opts.useTabs = true;
  else if (a === '--single-quote') opts.singleQuote = true;
  else if (a === '--no-semi') opts.semi = false;
  else if (a === '--trailing-comma') opts.trailingComma = args[++i];
  else if (a.startsWith('-')) {
    console.error(`prettier: unknown option ${a}\n${usage}`);
    exit(2);
  } else files.push(a);
}
let config = {};
if (await fs.exists('.prettierrc')) {
  try {
    config = JSON.parse(await fs.readText('.prettierrc'));
  } catch {
    console.error('prettier: .prettierrc is not JSON; ignoring it');
  }
}
if (!files.length) {
  if (!stdin) return print(usage);
  if (!opts.parser && !opts.filepath) {
    console.error('prettier: formatting stdin needs --parser or --stdin-filepath');
    exit(2);
  }
  const outText = await prettier.format(stdin, { ...config, ...opts, plugins });
  return void console.log(outText.replace(/\n$/, ''));
}
let failed = 0;
let unformatted = 0;
for (const file of files) {
  try {
    const text = await fs.readText(file);
    const o = { ...config, ...opts, filepath: file, plugins };
    if (mode === 'check') {
      if (!(await prettier.check(text, o))) (unformatted++, print(file));
      continue;
    }
    const formatted = await prettier.format(text, o);
    if (mode === 'write') {
      if (formatted !== text) await fs.writeFile(file, formatted);
      print(`${file}${formatted === text ? ' (unchanged)' : ''}`);
    } else console.log(formatted.replace(/\n$/, ''));
  } catch (e) {
    failed++;
    console.error(`${file}: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
if (failed) exit(2);
if (unformatted) exit(1);
