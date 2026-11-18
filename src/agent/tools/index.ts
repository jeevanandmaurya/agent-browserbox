import { devTools } from './dev';
import { execTools } from './exec';
import { publishTools } from './publish';
import { fsTools } from './fs';
import { systemTools } from './system';
import type { ToolDef } from './types';

export const ALL_TOOLS: ToolDef[] = [...fsTools, ...execTools, ...systemTools, ...devTools, ...publishTools];

/** A reduced set for small in-browser models with tiny context windows. */
export const LITE_TOOLS: ToolDef[] = ALL_TOOLS.filter((t) => ['read_file', 'write_file', 'list_dir', 'shell', 'run_js'].includes(t.name));

export type { ToolContext, ToolDef, TodoItem } from './types';
