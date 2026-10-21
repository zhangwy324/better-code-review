// The renderer (#28, design reference §8.7, §12.1 Option A): one self-contained review.html, the
// prebuilt viewer page with a review's data added as inert JSON elements (embed.ts). The page
// loads nothing (vite.config.ts), so it opens from `file://` with no network access. The
// changes.json, graph.json and plan.json it is made from stay next to it, for the agent and for
// debugging (spec D7). The same documents and viewer build always give the same bytes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DataName, dataScripts } from './embed.ts';

/** The page `npm run build` makes. The same path from src/renderer/ and dist/renderer/. */
export const VIEWER_TEMPLATE = new URL('../../dist/viewer/index.html', import.meta.url);

const FILES: Record<DataName, string> = {
  changes: 'changes.json',
  graph: 'graph.json',
  plan: 'plan.json',
};

/** The viewer page `template` with `documents` embedded at the end of its body. */
export function renderReview(template: string, documents: Record<DataName, unknown>): string {
  // The last `</body>`: the inlined script comes before it and could contain the text.
  const at = template.lastIndexOf('</body>');
  if (at === -1) throw new Error('The viewer page has no </body>.');
  return `${template.slice(0, at)}${dataScripts(documents)}\n${template.slice(at)}`;
}

/**
 * Writes `<dir>/review.html` from the changes.json, graph.json and plan.json in `dir`, and returns
 * its path. The viewer validates the documents when the page opens.
 */
export function writeReview(dir: string, template = readTemplate()): string {
  const documents = Object.fromEntries(
    Object.entries(FILES).map(([name, file]) => [
      name,
      JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown,
    ]),
  ) as Record<DataName, unknown>;
  const path = join(dir, 'review.html');
  writeFileSync(path, renderReview(template, documents));
  return path;
}

function readTemplate(): string {
  try {
    return readFileSync(VIEWER_TEMPLATE, 'utf8');
  } catch (error) {
    throw new Error('The viewer is not built: run `npm run build`.', { cause: error });
  }
}
