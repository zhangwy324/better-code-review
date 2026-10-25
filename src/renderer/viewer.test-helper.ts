// Builds the viewer page as `npm run build` does, so tests that need the template don't depend on
// a build having run first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, mergeConfig, type Plugin } from 'vite';
import { viewerConfig } from '../../vite.config.ts';

/**
 * Builds the viewer into `outDir` and returns its index.html, the renderer's template. `licence`
 * replaces the repository's LICENSE in the notices.
 */
export async function buildViewer(
  outDir: string,
  options: { licence?: URL } = {},
): Promise<string> {
  return (await buildViewerWithModules(outDir, options)).page;
}

/**
 * {@link buildViewer}, also returning the id of every module whose code is in the page: the
 * script's modules that kept any code after tree-shaking, and the stylesheets.
 */
export async function buildViewerWithModules(
  outDir: string,
  options: { licence?: URL } = {},
): Promise<{ page: string; modules: string[] }> {
  const modules: string[] = [];
  const record: Plugin = {
    name: 'record-bundled-modules',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(file.modules)) {
          if (module.renderedLength > 0 || id.endsWith('.css')) modules.push(id);
        }
      }
    },
  };
  await build(
    mergeConfig(viewerConfig(options), {
      configFile: false,
      root: fileURLToPath(new URL('../viewer', import.meta.url)),
      build: { outDir, emptyOutDir: true },
      logLevel: 'silent',
      plugins: [record],
    }),
  );
  return { page: readFileSync(join(outDir, 'index.html'), 'utf8'), modules };
}
