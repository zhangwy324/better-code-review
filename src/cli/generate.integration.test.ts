// `generate` with real language servers on the signature fixture (MVP spec M1: "with
// typescript-language-server and pyright installed"). Skipped unless both a TypeScript and a
// Python server are found; `npm run test:lsp` installs them (src/analysis/semantic/README.md).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SIGNATURE_BASE, SIGNATURE_HEAD } from '../analysis/semantic/fixture.test-helper.ts';
import { installedServers } from '../analysis/semantic/lsp-servers.test-helper.ts';
import { TestRepo } from '../git/test-repo.test-helper.ts';
import { ChangeGraph } from '../schemas/index.ts';
import { run } from './main.ts';

const ts = installedServers('typescript')[0]?.searchPath;
const py = installedServers('python')[0]?.searchPath;

const out = mkdtempSync(join(tmpdir(), 'bcr-out-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe.skipIf(ts === undefined || py === undefined)('generate with language servers', () => {
  it('verifies the changed callers and attaches no same-name symbol', async () => {
    const repo = new TestRepo();
    const head = repo.commit([repo.commit([], SIGNATURE_BASE)], SIGNATURE_HEAD);
    let stderr = '';
    const exitCode = await run(
      ['generate', '--commit', head, '--out', out],
      { cwd: repo.path, out: () => {}, err: (t) => (stderr += t) },
      {
        lsp: {
          searchPath: [ts, py].join(delimiter),
          timeouts: { emptyGraceMs: 3000, retryDelayMs: 500 },
        },
      },
    );
    expect(stderr).not.toContain('error');
    expect(exitCode).toBe(0);

    const graph = ChangeGraph.parse(JSON.parse(readFileSync(join(out, 'graph.json'), 'utf8')));
    expect(graph.languages.map((l) => [l.language, l.status])).toEqual([
      ['python', 'ok'],
      ['typescript', 'ok'],
    ]);
    const name = new Map(graph.nodes.map((n) => [n.id, n.displayName]));
    const edges = graph.codeEdges
      .map((e) =>
        e.granularity === 'entity'
          ? `${name.get(e.to)} <- ${name.get(e.from)} ${e.provenance}`
          : `${name.get(e.to)} <- ${e.fromPath} ${e.provenance}`,
      )
      .sort();
    expect(edges).toEqual([
      'formatPrice <- aliasCaller verified',
      'formatPrice <- checkoutSummary verified',
      'formatPrice <- invoiceSummary verified',
      'formatPrice <- receiptSummary verified',
      // The servers reject the new-side calls to Fmt.formatPrice and Calc.tax, but only see the
      // new side: the same calls on the old side stay undecided and keep these edges possible
      // (src/graph/build.ts). legacyLabel is rejected by import resolution on both sides.
      'formatPrice <- viaMethod possible',
      'tax <- order_total verified',
      'tax <- refund verified',
      'tax <- use_calc possible',
    ]);
    // A temporary worktree held the head for the servers; it is gone.
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 180_000);
});
