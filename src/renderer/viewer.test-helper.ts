// Builds the viewer page as `npm run build` does, so tests that need the template don't depend on
// a build having run first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, mergeConfig } from 'vite';
import { viewerConfig } from '../../vite.config.ts';

/**
 * Builds the viewer into `outDir` and returns its index.html, the renderer's template. `licence`
 * replaces the repository's LICENSE in the notices.
 */
export async function buildViewer(
  outDir: string,
  options: { licence?: URL } = {},
): Promise<string> {
  await build(
    mergeConfig(viewerConfig(options), {
      configFile: false,
      root: fileURLToPath(new URL('../viewer', import.meta.url)),
      build: { outDir, emptyOutDir: true },
      logLevel: 'silent',
    }),
  );
  return readFileSync(join(outDir, 'index.html'), 'utf8');
}
