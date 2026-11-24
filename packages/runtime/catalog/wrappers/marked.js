// marked: converts Markdown to HTML.
const { marked } = require('lib/marked.umd.js');
const usage = `usage: marked [file] [-o out.html] [--page] [--breaks] [--no-gfm]
  Reads the file (or stdin) and prints HTML, or writes it with -o.
  --page     a whole HTML page (with a title and simple styles), not a fragment`;
let input = null;
let output = null;
let page = false;
const o = { gfm: true, breaks: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') return print(usage);
  else if (a === '-o' || a === '--output') output = args[++i];
  else if (a === '--page' || a === '-s' || a === '--standalone') page = true;
  else if (a === '--breaks') o.breaks = true;
  else if (a === '--no-gfm') o.gfm = false;
  else if (a.startsWith('-')) {
    console.error(`marked: unknown option ${a}\n${usage}`);
    exit(2);
  } else input = a;
}
const md = input ? await fs.readText(input) : stdin;
if (!md && !input) return print(usage);
let html = await marked.parse(md, o);
if (page) {
  const title = (/^#\s+(.+)$/m.exec(md)?.[1] ?? (input ?? 'Document')).replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}pre{background:#f4f4f4;padding:.75rem;overflow:auto}code{font-family:ui-monospace,monospace}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.25rem .5rem}img{max-width:100%}@media (prefers-color-scheme:dark){body{background:#161616;color:#ddd}pre{background:#222}}</style>\n</head>\n<body>\n${html}</body>\n</html>\n`;
}
if (output) {
  await fs.writeFile(output, html);
  print(`wrote ${output}`);
} else console.log(html.replace(/\n$/, ''));
