// ocr: text from pictures (Tesseract 5, LSTM, compiled to WebAssembly by tesseract.js).
const TesseractCore = require('lib/tesseract-core-simd-lstm.wasm.js');
const usage = `usage: ocr picture.(png|jpg|webp|bmp|tif) … [-o out.txt] [--psm N]
  Prints the text it reads (English). Several pictures: one after the other.
  --psm 6   treat the picture as one block of text (default 3: find the layout)
  --psm 7   a single line,  --psm 11  scattered text
For a scanned PDF, make pictures of its pages first (e.g. ffmpeg, or ask the agent).`;
let out = null;
let psm = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') return print(usage);
  if (a === '-o' || a === '--output') out = args[++i];
  else if (a === '--psm') psm = args[++i];
  else files.push(a);
}
if (!files.length) return print(usage);
const gz = await asset('data/eng.traineddata.gz');
const lang = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const tm = await TesseractCore({ print: () => {}, printErr: () => {} });
tm.FS.writeFile('/eng.traineddata', lang);
const api = new tm.TessBaseAPI();
// OEM 1: the LSTM engine (the only one in this build).
if (api.Init(null, 'eng', 1) === -1) {
  console.error('ocr: the English language data could not be loaded');
  exit(1);
}
if (psm) api.SetVariable('tessedit_pageseg_mode', String(psm));
const texts = [];
for (const f of files) {
  const image = await fs.readFile(f);
  tm.FS.writeFile('/input', image);
  if (api.SetImageFile(1, 0) === 1) {
    console.error(`ocr: ${f}: cannot read this picture (PNG, JPEG, WebP, BMP or TIFF)`);
    exit(1);
  }
  const text = api.GetUTF8Text().trim();
  const conf = api.MeanTextConf();
  texts.push(files.length > 1 ? `--- ${f} (confidence ${conf}%) ---\n${text}` : text);
  if (files.length === 1) console.error(`(confidence ${conf}%)`);
}
api.End();
const all = texts.join('\n\n');
if (out) {
  await fs.writeFile(out, all);
  print(`wrote ${out}`);
} else print(all || '(no text found)');
