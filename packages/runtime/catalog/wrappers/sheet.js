// sheet: spreadsheets (Excel .xlsx/.xls, OpenDocument .ods, CSV, JSON) with SheetJS.
const XLSX = require('lib/xlsx.full.min.js');
const usage = `usage: sheet <command> …
  sheet info book.xlsx                      sheets, their size and first row
  sheet csv book.xlsx [--sheet Name] [-o out.csv]
  sheet json book.xlsx [--sheet Name] [-o out.json]   rows as objects (first row = keys)
  sheet make in.csv|in.json … -o out.xlsx  one sheet per input (named after the file)
  sheet convert in.xlsx out.(xlsx|xls|ods|csv|html|json)`;
const opts = { sheet: null, out: null };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') return print(usage);
  if (a === '--sheet' || a === '-s') opts.sheet = args[++i];
  else if (a === '-o' || a === '--output') opts.out = args[++i];
  else rest.push(a);
}
const [cmd, ...files] = rest;
if (!cmd) return print(usage);
const fail = (msg) => (console.error(`sheet: ${msg}`), exit(1));
const ext = (p) => (/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase();
const read = async (p) => {
  const e = ext(p);
  if (e === 'csv' || e === 'tsv' || e === 'txt') return XLSX.read(await fs.readText(p), { type: 'string', raw: false, FS: e === 'tsv' ? '\t' : undefined });
  if (e === 'json') {
    const data = JSON.parse(await fs.readText(p));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, Array.isArray(data) && Array.isArray(data[0]) ? XLSX.utils.aoa_to_sheet(data) : XLSX.utils.json_to_sheet(Array.isArray(data) ? data : [data]), 'Sheet1');
    return wb;
  }
  return XLSX.read(await fs.readFile(p), { type: 'array', cellDates: true });
};
const pick = (wb) => {
  const name = opts.sheet ?? wb.SheetNames[0];
  const ws = wb.Sheets[name];
  if (!ws) fail(`no sheet "${name}" (sheets: ${wb.SheetNames.join(', ')})`);
  return ws;
};
const emit = async (text) => {
  if (opts.out) {
    await fs.writeFile(opts.out, text);
    print(`wrote ${opts.out}`);
  } else console.log(text.replace(/\n$/, ''));
};
const write = async (wb, path) => {
  const e = ext(path);
  if (e === 'csv') return fs.writeFile(path, XLSX.utils.sheet_to_csv(pick(wb)));
  if (e === 'json') return fs.writeFile(path, JSON.stringify(XLSX.utils.sheet_to_json(pick(wb)), null, 2));
  if (e === 'html') return fs.writeFile(path, XLSX.utils.sheet_to_html(pick(wb)));
  const bookType = { xlsx: 'xlsx', xls: 'biff8', ods: 'ods', xlsb: 'xlsb' }[e];
  if (!bookType) fail(`cannot write .${e} (xlsx, xls, ods, xlsb, csv, json or html)`);
  return fs.writeFile(path, new Uint8Array(XLSX.write(wb, { type: 'array', bookType })));
};

if (cmd === 'info') {
  if (!files[0]) fail('which file?');
  const wb = await read(files[0]);
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'];
    const r = ref ? XLSX.utils.decode_range(ref) : null;
    const head = XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 })[0] ?? [];
    print(`${name}: ${r ? `${r.e.r - r.s.r + 1} rows × ${r.e.c - r.s.c + 1} columns (${ref})` : 'empty'}${head.length ? `\n  first row: ${head.join(' | ')}` : ''}`);
  }
} else if (cmd === 'csv') {
  if (!files[0]) fail('which file?');
  await emit(XLSX.utils.sheet_to_csv(pick(await read(files[0]))));
} else if (cmd === 'json') {
  if (!files[0]) fail('which file?');
  await emit(JSON.stringify(XLSX.utils.sheet_to_json(pick(await read(files[0])), { defval: null }), null, 2));
} else if (cmd === 'make') {
  if (!files.length || !opts.out) fail('usage: sheet make in.csv|in.json … -o out.xlsx');
  const wb = XLSX.utils.book_new();
  for (const f of files) {
    const src = await read(f);
    const base = f.replace(/^.*\//, '').replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; wb.SheetNames.includes(name); n++) name = `${base.slice(0, 28)} ${n}`;
    XLSX.utils.book_append_sheet(wb, src.Sheets[src.SheetNames[0]], name);
  }
  await write(wb, opts.out);
  print(`wrote ${opts.out} (${wb.SheetNames.length} sheet${wb.SheetNames.length === 1 ? '' : 's'})`);
} else if (cmd === 'convert') {
  const [from, to] = files;
  if (!from || !to) fail('usage: sheet convert in.xlsx out.ods');
  await write(await read(from), to);
  print(`wrote ${to}`);
} else fail(`unknown command ${cmd}\n${usage}`);
