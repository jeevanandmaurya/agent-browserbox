// docx: read Word documents (mammoth).
const mammoth = require('lib/mammoth.browser.min.js');
const usage = `usage: docx <command> file.docx [-o out]
  docx text file.docx     the text
  docx html file.docx     HTML (headings, lists, tables, links, pictures inline)
  docx md file.docx       Markdown`;
let out = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-h' || args[i] === '--help') return print(usage);
  if (args[i] === '-o' || args[i] === '--output') out = args[++i];
  else rest.push(args[i]);
}
const [cmd, file] = rest;
if (!cmd || !file) return print(usage);
const bytes = await fs.readFile(file);
const input = { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
const r = cmd === 'text' ? await mammoth.extractRawText(input) : cmd === 'html' ? await mammoth.convertToHtml(input) : cmd === 'md' ? await mammoth.convertToMarkdown(input) : null;
if (!r) {
  console.error(`docx: unknown command ${cmd}\n${usage}`);
  exit(2);
}
for (const m of r.messages ?? []) if (m.type === 'error') console.error(`docx: ${m.message}`);
if (out) {
  await fs.writeFile(out, r.value);
  print(`wrote ${out}`);
} else console.log(r.value.replace(/\n+$/, ''));
