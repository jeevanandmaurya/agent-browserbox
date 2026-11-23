import type { PackageManifest } from '../types';

export default {
  id: 'sqlite',
  version: 'SQLite 3 (sql.js)',
  summary: 'SQL database engine for .db files in the workspace',
  commands: ['sqlite3'],
  tools: [],
  default: true,
} satisfies PackageManifest;
