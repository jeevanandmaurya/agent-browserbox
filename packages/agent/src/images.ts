import type { KernelCore as Kernel } from './host/os.js';
import type { Block, ImageRef, Msg } from './types.js';

/** Image formats every vision model accepts. */
const TYPES: Record<string, ImageRef['mediaType']> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** The largest image APIs accept inline. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Roughly what one image costs in context. */
export const IMAGE_TOKENS = 1600;

export const isImagePath = (path: string): boolean => (path.split('.').pop()?.toLowerCase() ?? '') in TYPES;

/** Checks that a file is an image a model can see and returns its reference. Throws a readable error otherwise. */
export async function imageRef(os: Kernel, path: string): Promise<ImageRef> {
  const mediaType = TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
  if (!mediaType) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image`);
  const st = await os.fs.stat(path).catch(() => null);
  if (!st) throw new Error(`${path} does not exist`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`${path} is ${(st.size / 1048576).toFixed(1)} MB; images can be at most 5 MB`);
  return { path, mediaType };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The conversation with every image's data filled in, for a model request.
 * The messages themselves are not changed; an image that is gone becomes a note.
 */
export async function withImageData(os: Kernel, messages: Msg[], cache: Map<string, string>): Promise<Msg[]> {
  const load = async (ref: ImageRef): Promise<ImageRef | null> => {
    let data = cache.get(ref.path);
    if (data === undefined) {
      const bytes = await os.fs.readFile(ref.path).catch(() => null);
      if (!bytes) return null;
      cache.set(ref.path, (data = base64(bytes)));
    }
    return { path: ref.path, mediaType: ref.mediaType, data };
  };
  const gone = (path: string): Block => ({ type: 'text', text: `[image ${path} is no longer available]` });
  const hasImages = (m: Msg) => m.content.some((b) => b.type === 'image' || (b.type === 'tool_result' && b.images?.length));
  return Promise.all(
    messages.map(async (m) => {
      if (!hasImages(m)) return m;
      const content: Block[] = [];
      for (const b of m.content) {
        if (b.type === 'image') {
          const full = await load(b);
          content.push(full ? { type: 'image', ...full } : gone(b.path));
        } else if (b.type === 'tool_result' && b.images?.length) {
          const images = (await Promise.all(b.images.map(load))).filter((x): x is ImageRef => x !== null);
          content.push({ ...b, images, ...(images.length < b.images.length ? { content: `${b.content}\n(some images are no longer available)` } : {}) });
        } else content.push(b);
      }
      return { ...m, content };
    }),
  );
}
