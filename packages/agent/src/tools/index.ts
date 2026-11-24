import { previewTools } from './preview.js';
import { devTools } from './dev.js';
import { execTools } from './exec.js';
import { publishTools } from './publish.js';
import { memoryTools } from './memory.js';
import { artifactTools } from './artifacts.js';
import { fsTools } from './fs.js';
import { systemTools } from './system.js';
import { webTools } from './web.js';
import type { ToolDef } from './types.js';

export const ALL_TOOLS: ToolDef[] = [...fsTools, ...execTools, ...systemTools, ...webTools, ...devTools, ...previewTools, ...publishTools, ...memoryTools, ...artifactTools];

/** A reduced set for small in-browser models with tiny context windows. */
export const LITE_TOOLS: ToolDef[] = ALL_TOOLS.filter((t) => ['read_file', 'write_file', 'list_dir', 'shell', 'run_js'].includes(t.name));

export type { ToolContext, ToolDef, TodoItem } from './types.js';
