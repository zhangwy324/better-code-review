// Copies the non-TypeScript files the compiled code reads at run time from src/ to dist/.
// Usage: node scripts/copy-assets.ts (run by `npm run build`, after tsc)
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSET_DIRS = ['analysis/structural/grammars', 'analysis/structural/queries'];

for (const dir of ASSET_DIRS) {
  cpSync(join(root, 'src', dir), join(root, 'dist', dir), { recursive: true });
}
console.log(`Copied ${ASSET_DIRS.length} asset directories to dist/`);
