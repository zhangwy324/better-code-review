// `generate` with real language servers on the signature fixture (MVP spec M1: "with
// typescript-language-server and pyright installed"). Skipped unless both a TypeScript and a
// Python server are found; `npm run test:lsp` installs them (src/analysis/semantic/README.md).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // The base side gets its own servers, for the old-side twins of the rejected collisions.
    expect(graph.languages.map((l) => [l.language, l.side, l.status])).toEqual([
      ['python', 'new', 'ok'],
      ['typescript', 'new', 'ok'],
      ['typescript', 'old', 'ok'],
      ['python', 'old', 'ok'],
    ]);
    expect(readFileSync(join(out, 'summary.txt'), 'utf8')).toMatch(/typescript \(old side\) +ok/);
    const name = new Map(graph.nodes.map((n) => [n.id, n.displayName]));
    const edges = graph.codeEdges
      .map((e) =>
        e.granularity === 'entity'
          ? `${name.get(e.to)} <- ${name.get(e.from)} ${e.provenance} ${e.sides}`
          : `${name.get(e.to)} <- ${e.fromPath} ${e.provenance} ${e.sides}`,
      )
      .sort();
    // The calls to Fmt.formatPrice and Calc.tax are rejected on both sides, and legacyLabel by
    // import resolution, so no same-name symbol is attached to the changed ones (M1).
    expect(edges).toEqual([
      'formatPrice <- aliasCaller verified both',
      'formatPrice <- checkoutSummary verified both',
      'formatPrice <- invoiceSummary verified both',
      'formatPrice <- receiptSummary verified both',
      'tax <- order_total verified both',
      'tax <- refund verified both',
    ]);
    // The servers' checkouts are not worktrees.
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  }, 180_000);
});

// #117: a checkout has no node_modules, so a package import kept the TypeScript server unhealthy
// on both sides and the summary asked for `npm ci`, though the working tree had it installed.
describe.skipIf(ts === undefined)("generate with the working tree's node_modules", () => {
  // The TypeScript half of the signature fixture, with a package import in fmt.ts, whose
  // `f.formatPrice` collision only the server can reject.
  const withDep = (files: Record<string, string | null>) =>
    Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => !path.endsWith('.py'))
        .map(([path, text]) => [
          path,
          path === 'src/fmt.ts' ? `import type { Dep } from 'dep';\n${text}` : text,
        ]),
    );

  async function generate(installed: boolean) {
    const repo = new TestRepo();
    const head = repo.commit([repo.commit([], withDep(SIGNATURE_BASE))], withDep(SIGNATURE_HEAD));
    if (installed) {
      const dep = join(repo.path, 'node_modules', 'dep');
      mkdirSync(dep, { recursive: true });
      writeFileSync(join(dep, 'package.json'), '{ "name": "dep", "types": "index.d.ts" }\n');
      writeFileSync(join(dep, 'index.d.ts'), 'export interface Dep {}\n');
    }
    const dir = join(out, installed ? 'installed' : 'none');
    let stderr = '';
    const exitCode = await run(
      ['generate', '--commit', head, '--out', dir],
      { cwd: repo.path, out: () => {}, err: (t) => (stderr += t) },
      { lsp: { searchPath: ts!, timeouts: { emptyGraceMs: 3000, retryDelayMs: 500 } } },
    );
    expect(stderr).not.toContain('error');
    expect(exitCode).toBe(0);
    const graph = ChangeGraph.parse(JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')));
    if (installed) {
      // The user's install is still there after the checkout was removed.
      expect(existsSync(join(repo.path, 'node_modules', 'dep', 'index.d.ts'))).toBe(true);
    }
    return { graph, summary: readFileSync(join(dir, 'summary.txt'), 'utf8') };
  }

  const typescript = (graph: ChangeGraph) =>
    graph.languages.filter((l) => l.language === 'typescript');

  it('resolves packages on both sides from the working tree', async () => {
    const { graph } = await generate(true);
    expect(typescript(graph).map((l) => [l.side, l.status])).toEqual([
      ['new', 'ok'],
      ['old', 'ok'],
    ]);
    expect(typescript(graph)[0]!.server!.configuration).toContain(
      'node_modules linked from the working tree',
    );
  }, 180_000);

  it('asks for an install in the working tree when it has none', async () => {
    const { graph, summary } = await generate(false);
    const [head] = typescript(graph);
    expect(head!.status).toBe('unhealthy');
    expect(head!.guidance).toContain("Cannot find module 'dep'");
    expect(head!.guidance).toContain(
      "the working tree has no node_modules to lend it. Install the project's dependencies in the working tree",
    );
    expect(summary).toContain('working tree has no node_modules');
  }, 180_000);
});
