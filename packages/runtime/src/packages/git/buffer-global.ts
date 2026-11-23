// isomorphic-git expects Node's Buffer as a global; this module runs before it loads.
import { Buffer } from 'buffer';

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
