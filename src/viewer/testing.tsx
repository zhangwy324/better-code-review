// Shared setup for the viewer's tests: review data generated from a real fixture repository, the
// page review.html would embed it in, and the browser APIs jsdom lacks. Importing this installs the
// stand-ins. `generate` runs in a child process: jsdom replaces Node's URL, which the analyzers need.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { buildFixtureRepo } from '../../test/fixtures/repo.ts';
import { signature } from '../../test/fixtures/signature.ts';
import { dataScripts } from '../renderer/embed.ts';
import { App } from './App.tsx';
import { loadReviewData, type ReviewData } from './data.ts';

// jsdom has no ResizeObserver; the panel library only needs it to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// Nor DOMMatrixReadOnly, which React Flow reads the zoom from (its testing guide does the same).
globalThis.DOMMatrixReadOnly ??= class {
  m22 = 1;
} as unknown as typeof DOMMatrixReadOnly;

/** Runs `generate --no-lsp` on `commit` of the repository at `repo`, and reads its documents. */
export function generateReview(repo: string, commit: string, out: string): ReviewData {
  const main = join(import.meta.dirname, '..', 'cli', 'main.ts');
  execFileSync(process.execPath, [main, 'generate', '--commit', commit, '--no-lsp', '--out', out], {
    cwd: repo,
    stdio: 'ignore',
  });
  const read = (file: string): unknown => JSON.parse(readFileSync(join(out, file), 'utf8'));
  return {
    changeSet: read('changes.json') as ReviewData['changeSet'],
    graph: read('graph.json') as ReviewData['graph'],
    plan: read('plan.json') as ReviewData['plan'],
  };
}

/** The signature fixture's review, generated in a temporary directory that `dispose` removes. */
export function signatureReview(): { data: ReviewData; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'bcr-viewer-'));
  const { head } = buildFixtureRepo(join(root, 'repo'), signature);
  const data = generateReview(join(root, 'repo'), head, join(root, 'out'));
  return { data, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** `data` as the documents review.html embeds. */
export const embedded = (data: ReviewData) => ({
  changes: data.changeSet,
  graph: data.graph,
  plan: data.plan,
});

/** Embeds `documents` in the page as review.html would, then loads and renders them. */
export function renderEmbedded(documents: { changes: unknown; graph: unknown; plan: unknown }) {
  document.body.innerHTML = dataScripts(documents);
  return render(<App result={loadReviewData(document)} />);
}
