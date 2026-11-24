// pdf: read, combine and make PDF files (pdf-lib; text with pdf.js).
const PDFLib = require('lib/pdf-lib.min.js');
const usage = `usage: pdf <command> …
  pdf info file.pdf                        pages, size, title, author
  pdf text file.pdf [--pages 1-3] [-o out.txt]   the text, page by page
  pdf merge a.pdf b.pdf … -o out.pdf
  pdf pages file.pdf --pages 1-3,7 -o out.pdf    keep (and order) some pages
  pdf rotate file.pdf 90 [--pages 2,4] -o out.pdf
  pdf images a.png b.jpg … -o out.pdf      one page per picture (PNG or JPEG)
  pdf from-text notes.txt|notes.md [-o out.pdf] [--title T]   plain text laid out on A4
Pages are numbered from 1; ranges like 2-5, lists like 1,3,9-10.`;
const opts = { out: null, pages: null, title: null };
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') return print(usage);
  if (a === '-o' || a === '--output') opts.out = args[++i];
  else if (a === '--pages' || a === '-p') opts.pages = args[++i];
  else if (a === '--title') opts.title = args[++i];
  else rest.push(a);
}
const [cmd, ...files] = rest;
if (!cmd) return print(usage);
const fail = (msg) => (console.error(`pdf: ${msg}`), exit(1));
const pagesOf = (spec, count) => {
  if (!spec) return [...Array(count).keys()];
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+|end))?\s*$/.exec(part);
    if (!m) fail(`bad page range "${part}"`);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === 'end' ? count : Number(m[2]);
    for (let p = a; a <= b ? p <= b : p >= b; p += a <= b ? 1 : -1) {
      if (p < 1 || p > count) fail(`page ${p} does not exist (the file has ${count})`);
      out.push(p - 1);
    }
  }
  return out;
};
const load = async (p) => PDFLib.PDFDocument.load(await fs.readFile(p), { ignoreEncryption: true });
const save = async (doc) => {
  if (!opts.out) fail('where to? add -o out.pdf');
  const bytes = await doc.save();
  await fs.writeFile(opts.out, bytes);
  print(`wrote ${opts.out} (${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'}, ${Math.round(bytes.length / 1024)} KB)`);
};

if (cmd === 'info') {
  if (!files[0]) fail('which file?');
  const doc = await load(files[0]);
  const p = doc.getPage(0).getSize();
  const meta = [['title', doc.getTitle()], ['author', doc.getAuthor()], ['subject', doc.getSubject()], ['creator', doc.getCreator()], ['created', doc.getCreationDate()?.toISOString()]].filter(([, v]) => v);
  print(`${files[0]}: ${doc.getPageCount()} pages, first page ${Math.round(p.width)}×${Math.round(p.height)} pt (${(p.width / 72 * 25.4).toFixed(0)}×${(p.height / 72 * 25.4).toFixed(0)} mm)`);
  for (const [k, v] of meta) print(`${k}: ${v}`);
} else if (cmd === 'text') {
  if (!files[0]) fail('which file?');
  // pdf.js, run on this thread (its worker code is loaded as a library).
  globalThis.pdfjsWorker = require('lib/pdf.worker.min.js');
  const pdfjs = require('lib/pdf.min.js');
  const doc = await pdfjs.getDocument({ data: await fs.readFile(files[0]), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const parts = [];
  for (const i of pagesOf(opts.pages, doc.numPages)) {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) text += (item.str ?? '') + (item.hasEOL ? '\n' : item.str && !item.str.endsWith(' ') ? ' ' : '');
    parts.push(`--- page ${i + 1} ---\n${text.replace(/[ \t]+\n/g, '\n').trim()}`);
  }
  const all = parts.join('\n\n');
  if (opts.out) {
    await fs.writeFile(opts.out, all);
    print(`wrote ${opts.out}`);
  } else print(all || '(no text: a scanned PDF needs OCR, see the ocr package)');
} else if (cmd === 'merge') {
  if (files.length < 2) fail('give two or more PDF files');
  const out = await PDFLib.PDFDocument.create();
  for (const f of files) {
    const src = await load(f);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  await save(out);
} else if (cmd === 'pages') {
  if (!files[0]) fail('which file?');
  const src = await load(files[0]);
  const out = await PDFLib.PDFDocument.create();
  for (const p of await out.copyPages(src, pagesOf(opts.pages, src.getPageCount()))) out.addPage(p);
  await save(out);
} else if (cmd === 'rotate') {
  const [file, deg] = files;
  if (!file || !/^-?\d+$/.test(deg ?? '') || Number(deg) % 90) fail('usage: pdf rotate file.pdf 90|180|270 [--pages …] -o out.pdf');
  const doc = await load(file);
  for (const i of pagesOf(opts.pages, doc.getPageCount())) {
    const page = doc.getPage(i);
    page.setRotation(PDFLib.degrees((page.getRotation().angle + Number(deg) + 360) % 360));
  }
  await save(doc);
} else if (cmd === 'images') {
  if (!files.length) fail('give PNG or JPEG files');
  const doc = await PDFLib.PDFDocument.create();
  for (const f of files) {
    const bytes = await fs.readFile(f);
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpg) fail(`${f}: only PNG and JPEG pictures`);
    const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    doc.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  await save(doc);
} else if (cmd === 'from-text') {
  if (!files[0]) fail('which file?');
  const src = await fs.readText(files[0]);
  const md = /\.md$/i.test(files[0]);
  opts.out ??= files[0].replace(/\.[^./]+$/, '') + '.pdf';
  const doc = await PDFLib.PDFDocument.create();
  const fonts = { body: await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold), mono: await doc.embedFont(PDFLib.StandardFonts.Courier) };
  doc.setTitle(opts.title ?? (/^#\s+(.+)$/m.exec(src)?.[1] ?? files[0].replace(/^.*\//, '')));
  // The standard fonts only have Western European letters: others become '?'.
  const safe = (t) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
  const [W, H, M] = [595.28, 841.89, 56];
  let page = doc.addPage([W, H]);
  let y = H - M;
  const line = (text, font, size, gap = 1.35) => {
    if (y - size < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
    page.drawText(text, { x: M, y: y - size, size, font });
    y -= size * gap;
  };
  const wrap = (text, font, size) => {
    const words = safe(text).split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (cur && font.widthOfTextAtSize((cur + w).trimEnd(), size) > W - 2 * M) {
        line(cur.trimEnd(), font, size);
        cur = w.trimStart();
      } else cur += w;
    }
    line(cur.trimEnd(), font, size);
  };
  let code = false;
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (md && /^\s*```/.test(raw)) {
      code = !code;
      continue;
    }
    if (code) {
      line(safe(raw) || ' ', fonts.mono, 9.5, 1.3);
      continue;
    }
    const h = md && /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      y -= 6;
      wrap(h[2].replace(/[*_`]/g, ''), fonts.bold, [20, 16, 13.5, 12, 11, 11][h[1].length - 1]);
      y -= 2;
    } else if (!raw.trim()) y -= 7;
    else wrap(md ? raw.replace(/\*\*|__|`/g, '').replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2').replace(/^\s*[-*+]\s+/, '• ').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') : raw, fonts.body, 11);
  }
  await save(doc);
} else fail(`unknown command ${cmd}\n${usage}`);
