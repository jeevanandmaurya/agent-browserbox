// ffmpeg and ffprobe (FFmpeg 6 compiled to WebAssembly by ffmpeg.wasm, one thread).
// Files named in the arguments are copied in; files it writes are copied back.
const createFFmpegCore = require('lib/ffmpeg-core.js');
const probe = args[0] === '--ffprobe';
const argv = probe ? args.slice(1) : args;
if (!argv.length || argv[0] === '-h' && argv.length === 1) {
  return print(`usage: ${probe ? 'ffprobe' : 'ffmpeg'} [options] (as FFmpeg's own)
  e.g. ffmpeg -i in.mov -vf scale=1280:-2 out.mp4
       ffmpeg -i talk.mp4 -vn -c:a libmp3lame talk.mp3
       ffmpeg -i clip.mp4 -ss 3 -frames:v 1 frame.png
       ffprobe -hide_banner in.mp4
Files are read from and written to the working folder. One thread, so big
videos take a while; a run may last 10 minutes at most.`);
}
const cwd = env.PWD || '/';
const abs = (p) => (p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`).replace(/\/\.\//g, '/');
// The core reads where its files are from its script address (#base64 JSON); the WebAssembly is given here.
const core = await createFFmpegCore({ wasmBinary: await asset('lib/ffmpeg-core.wasm'), mainScriptUrlOrBlob: `ffmpeg-core.js#${btoa(JSON.stringify({ wasmURL: 'ffmpeg-core.wasm', workerURL: '' }))}` });
core.setLogger(({ type, message }) => (type === 'stdout' ? console.log : console.error)(message));
const FS = core.FS;
const mkdirs = (dir) => {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    cur += `/${part}`;
    try {
      FS.mkdir(cur);
    } catch {
      /* exists */
    }
  }
};
mkdirs(cwd);
FS.chdir(cwd);
// Inputs: every argument that names a file in the box.
const copied = new Map();
for (const a of argv) {
  if (a.startsWith('-') || /^[a-z]+:\/\//i.test(a)) continue;
  for (const cand of [a, ...a.split(/[=:,]/).filter((x) => /\.[a-z0-9]{2,5}$/i.test(x))]) {
    const path = abs(cand);
    if (copied.has(path) || !(await fs.exists(cand))) continue;
    const bytes = await fs.readFile(cand).catch(() => null);
    if (!bytes) continue;
    mkdirs(path.replace(/\/[^/]*$/, ''));
    FS.writeFile(path, bytes);
    copied.set(path, FS.stat(path).mtime.getTime());
  }
}
// The folders it may write to: the working folder and those named in the arguments.
const dirs = new Set([cwd]);
for (const a of argv) if (!a.startsWith('-') && a.includes('/')) dirs.add(abs(a).replace(/\/[^/]*$/, '') || '/');
for (const d of dirs) mkdirs(d);
// ffprobe in this build ends without setting its exit code (-1, "not finished"): that is success.
const ret = probe ? core.ffprobe(...argv) : core.exec(...argv);
const code = probe && ret === -1 ? 0 : ret;
// Anything new or changed goes back into the box.
const written = [];
for (const d of dirs) {
  let names = [];
  try {
    names = FS.readdir(d).filter((n) => n !== '.' && n !== '..');
  } catch {
    continue;
  }
  for (const n of names) {
    const path = `${d === '/' ? '' : d}/${n}`;
    const st = FS.stat(path);
    if (FS.isDir(st.mode)) continue;
    if (copied.has(path) && copied.get(path) === st.mtime.getTime()) continue;
    await fs.writeFile(path, FS.readFile(path));
    written.push(path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
  }
}
if (written.length) console.error(`(wrote ${written.join(', ')})`);
if (code !== 0) exit(code === undefined ? 1 : code);
