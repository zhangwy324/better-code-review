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

/** The name of the page in a review directory. */
export const REVIEW_FILE = 'review.html';

export interface WriteReviewOptions {
  /** The viewer page; by default the one `npm run build` made. */
  template?: string | undefined;
  /** The plan to embed instead of plan.json: the validated one, with Ungrouped made (#23). */
  plan?: unknown;
}

/**
 * Writes `<dir>/review.html` from the changes.json, graph.json and plan.json in `dir`, and returns
 * its path. The viewer validates the documents when the page opens.
 */
export function writeReview(dir: string, options: WriteReviewOptions = {}): string {
  const template = options.template ?? readTemplate();
  const documents = Object.fromEntries(
    Object.entries(FILES).map(([name, file]) => [
      name,
      name === 'plan' && options.plan !== undefined
        ? options.plan
        : readReviewJson(join(dir, file)),
    ]),
  ) as Record<DataName, unknown>;
  const path = join(dir, REVIEW_FILE);
  writeFileSync(path, renderReview(template, documents));
  return path;
}

/**
 * The JSON document at `path`, parsed. When the file can't be read or isn't JSON, the error names
 * it (#110), so the user or agent knows which of the review's files to fix; the original is the
 * `cause`.
 */
export function readReviewJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${path}: ${(error as Error).message}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
}

/** The viewer page is missing: a checkout that has not run `npm run build`. */
export class ViewerNotBuiltError extends Error {}

function readTemplate(): string {
  try {
    return readFileSync(VIEWER_TEMPLATE, 'utf8');
  } catch (error) {
    throw new ViewerNotBuiltError('The viewer is not built: run `npm run build`.', {
      cause: error,
    });
  }
}
