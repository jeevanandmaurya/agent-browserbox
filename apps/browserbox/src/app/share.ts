import { mimeOf } from '@jeevanand/agent-browserbox-runtime/client';

/**
 * Sharing to other apps on this device (Web Share): mail, messages, notes,
 * AirDrop, … Only where the browser can share files (most phones, Safari,
 * Chrome on Windows and ChromeOS).
 */
export function canShareFiles(): boolean {
  const nav = navigator as Navigator & { canShare?(d: ShareData): boolean };
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    return nav.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

/** A file to share: browsers share only common types, so other text goes as plain text. */
export function shareableFile(name: string, data: Uint8Array | string): File {
  let type = mimeOf(name) || 'application/octet-stream';
  if (/^(text\/|application\/(json|javascript|xml|x-yaml|yaml|toml))/.test(type) && type !== 'text/html' && type !== 'text/csv') type = 'text/plain';
  return new File([data as BlobPart], name, { type });
}

/** Opens the device's share sheet; false when the person cancelled or the files cannot be shared. */
export async function shareFiles(files: File[], title?: string): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?(d: ShareData): boolean };
  if (!nav.canShare?.({ files })) throw new Error('This browser cannot share these files. Download them instead.');
  try {
    await nav.share({ files, title });
    return true;
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return false;
    throw err;
  }
}
