// yaml2json / json2yaml: converts between YAML and JSON (js-yaml).
const yaml = require('dist/js-yaml.min.js');
const toJson = args[0] === '--to-json';
const rest = args.slice(1);
const name = toJson ? 'yaml2json' : 'json2yaml';
const usage = `usage: ${name} [file] [-o out] ${toJson ? '[--indent N] [--compact]' : '[--indent N]'}\n  Reads the file (or stdin) and prints ${toJson ? 'JSON' : 'YAML'}, or writes it with -o.`;
let input = null;
let output = null;
let indent = 2;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '-h' || a === '--help') return print(usage);
  else if (a === '-o' || a === '--output') output = rest[++i];
  else if (a === '--indent') indent = Number(rest[++i]) || 2;
  else if (a === '--compact') indent = 0;
  else if (a.startsWith('-')) {
    console.error(`${name}: unknown option ${a}\n${usage}`);
    exit(2);
  } else input = a;
}
const text = input ? await fs.readText(input) : stdin;
if (!text && !input) return print(usage);
let result;
try {
  if (toJson) {
    const docs = yaml.loadAll(text);
    result = JSON.stringify(docs.length === 1 ? docs[0] : docs, null, indent || undefined) + '\n';
  } else result = yaml.dump(JSON.parse(text), { indent, lineWidth: 100, noRefs: true });
} catch (e) {
  console.error(`${name}: ${String(e?.message ?? e)}`);
  exit(1);
}
if (output) {
  await fs.writeFile(output, result);
  print(`wrote ${output}`);
} else console.log(result.replace(/\n$/, ''));
