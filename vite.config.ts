// Builds the viewer (src/viewer) into one file, dist/viewer/index.html: the template the renderer
// (src/renderer) adds a review's data to, to make review.html. `npm run viewer` serves the viewer
// with a review's data for development.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

export default defineConfig({
  root: 'src/viewer',
  base: './',
  plugins: [react(), singleFile()],
  build: {
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    // The bundled dependencies' licences, for the page's notices (ADR 0002).
    license: true,
    // The polyfill fetches modules, and one inline script has nothing to preload.
    modulePreload: false,
  },
});

/**
 * Inlines the script, the styles and the third-party notices into index.html, so the page loads
 * nothing (spec D7, design reference §14.2). Its Content-Security-Policy allows only that script,
 * inline styles and data: images, so no browser fetches anything for it, whatever a later change
 * tries.
 */
function singleFile(): Plugin {
  return {
    name: 'better-code-review-single-file',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const files = Object.values(bundle);
        const take = (kind: string, test: (fileName: string) => boolean) => {
          const found = files.filter((f) => test(f.fileName));
          if (found.length !== 1) {
            throw new Error(`Expected one ${kind} in the viewer bundle, found ${found.length}`);
          }
          delete bundle[found[0]!.fileName];
          return found[0]!;
        };
        const source = (file: (typeof files)[number]) =>
          file.type === 'chunk' ? file.code : String(file.source);
        const html = take('page', (f) => f === 'index.html');
        const script = take('script', (f) => f.endsWith('.js'));
        const style = take('stylesheet', (f) => f.endsWith('.css'));
        const licences = take('licence file', (f) => f.endsWith('license.md'));
        if (Object.keys(bundle).length > 0) {
          throw new Error(`Unexpected viewer files: ${Object.keys(bundle).join(', ')}`);
        }

        // The page must not end the element early or open a comment inside it.
        const js = source(script);
        const css = source(style);
        assertAbsent(js, /<\/script|<!--/i, 'the viewer script');
        assertAbsent(css, /<\/style|<!--/i, 'the viewer styles');
        const notices = [
          'Better Code Review',
          readFileSync(new URL('LICENSE', import.meta.url), 'utf8').trim(),
          source(licences).trim(),
        ].join('\n\n');
        assertAbsent(notices, /<!--|-->|--!>/, 'the licence notices');

        const hash = createHash('sha256').update(js).digest('base64');
        const csp = [
          "default-src 'none'",
          `script-src 'sha256-${hash}'`,
          "style-src 'unsafe-inline'",
          'img-src data:',
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        let page = source(html);
        page = replaceOnce(
          page,
          '<meta charset="utf-8" />',
          (charset) =>
            `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        );
        page = replaceOnce(
          page,
          /<script type="module" crossorigin src="[^"]*"><\/script>/,
          () => `<script type="module">${js}</script>`,
        );
        page = replaceOnce(
          page,
          /<link rel="stylesheet" crossorigin href="[^"]*">/,
          () => `<style>${css}</style>`,
        );
        // After the charset, which browsers look for in the first 1024 bytes.
        page = replaceOnce(page, '</head>', () => `<!--\n${notices}\n-->\n  </head>`);
        this.emitFile({ type: 'asset', fileName: 'index.html', source: page });
      },
    },
  };
}

function assertAbsent(text: string, pattern: RegExp, what: string): void {
  const match = pattern.exec(text);
  if (match) throw new Error(`${what} contains "${match[0]}", which would break the page`);
}

/** `text` with its one match of `search` replaced. A function keeps `$` in the code literal. */
function replaceOnce(text: string, search: string | RegExp, replace: (match: string) => string) {
  const count =
    typeof search === 'string'
      ? text.split(search).length - 1
      : [...text.matchAll(new RegExp(search, 'g'))].length;
  if (count !== 1) throw new Error(`Expected one ${String(search)} in the viewer page`);
  return text.replace(search, replace);
}
