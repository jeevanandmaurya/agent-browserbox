import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the built runtime (embed/, kernel/, assets/, …). Serve this
 * folder as static files, e.g. copy it to your site's public/browserbox/, and
 * pass its URL to the SDK: BrowserBox.boot({ runtimeUrl: '/browserbox/' }).
 */
export const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), 'dist');
