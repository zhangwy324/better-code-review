// Builds the viewer page as `npm run build` does, so tests that need the template don't depend on
// a build having run first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/** Builds the viewer into `outDir` and returns its index.html, the renderer's template. */
export async function buildViewer(outDir: string): Promise<string> {
  await build({
    configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    root: fileURLToPath(new URL('../viewer', import.meta.url)),
    build: { outDir, emptyOutDir: true },
    logLevel: 'silent',
  });
  return readFileSync(join(outDir, 'index.html'), 'utf8');
}
