// `generate` end to end through `run`, on real repositories: the signature fixture as a commit,
// range and pull request, a working tree, and files without structure.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SIGNATURE_BASE, SIGNATURE_HEAD } from '../analysis/semantic/fixture.test-helper.ts';
import type { GhRunner } from '../git/pr.ts';
import { TestRepo } from '../git/test-repo.test-helper.ts';
import { ChangeGraph, ChangeSet, ReviewPlan } from '../schemas/index.ts';
import { EXIT, run, type TestHooks } from './main.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bcr-out-'));
  dirs.push(dir);
  return dir;
}

async function generate(cwd: string, argv: string[], hooks: TestHooks = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await run(
    ['generate', ...argv],
    { cwd, out: (t) => (stdout += t), err: (t) => (stderr += t) },
    hooks,
  );
  return { exitCode, stdout, stderr };
}

function readOutputs(dir: string) {
  const changes = ChangeSet.parse(JSON.parse(readFileSync(join(dir, 'changes.json'), 'utf8')));
  const graph = ChangeGraph.parse(JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')));
  return { changes, graph, summary: readFileSync(join(dir, 'summary.txt'), 'utf8') };
}

function signatureRepo() {
  const repo = new TestRepo();
  const base = repo.commit([], SIGNATURE_BASE);
  const head = repo.commit([base], SIGNATURE_HEAD);
  return { repo, base, head };
}

/** `to <- from` for every entity edge, by display name. */
function edges(graph: ChangeGraph): string[] {
  const name = new Map(graph.nodes.map((n) => [n.id, n.displayName]));
  return graph.codeEdges
    .map((e) =>
      e.granularity === 'entity'
        ? `${name.get(e.to)} <- ${name.get(e.from)} ${e.provenance}`
        : `${name.get(e.to)} <- ${e.fromPath} ${e.provenance}`,
    )
    .sort();
}

describe('generate', () => {
  it('writes changes.json, graph.json, planner-input.md, plan.json and summary.txt for a commit, with no LSP', async () => {
    const { repo, head } = signatureRepo();
    const result = await generate(repo.path, ['--commit', head, '--no-lsp']);
    expect(result.stderr).not.toContain('error');
    expect(result.exitCode).toBe(EXIT.ok);

    const dir = join(repo.path, '.better-code-review', 'reviews', `commit-${head.slice(0, 7)}`);
    const { changes, graph, summary } = readOutputs(dir);
    expect(changes.headRevision).toBe(head);
    expect(graph.snapshotId).toBe(changes.snapshotId);
    expect(graph.uncoveredHunkIds).toEqual([]);

    // MVP spec M1: the updated callers have `possible` edges to formatPrice, emailSummary is
    // absent (D12) and nothing is verified.
    const toFormatPrice = edges(graph).filter((e) => e.startsWith('formatPrice <- '));
    for (const caller of ['checkoutSummary', 'invoiceSummary', 'receiptSummary']) {
      expect(toFormatPrice).toContain(`formatPrice <- ${caller} possible`);
    }
    expect(graph.nodes.map((n) => n.displayName)).not.toContain('emailSummary');
    expect(graph.codeEdges.filter((e) => e.provenance === 'verified')).toEqual([]);
    expect(graph.languages.map((l) => l.status)).toEqual(graph.languages.map(() => 'disabled'));

    const hunks = changes.files.flatMap((f) => f.hunks).length;
    expect(summary).toContain(`${hunks}/${hunks} hunks mapped`);
    expect(summary).toContain('Unchanged callers are not analysed.');
    expect(summary).toMatch(
      new RegExp(`Planner   ~[\\d,]+ estimated tokens, ${hunks}/${hunks} hunks inlined`),
    );
    const input = readFileSync(join(dir, 'planner-input.md'), 'utf8');
    for (const node of graph.nodes) expect(input).toContain(node.id);
    // The fallback plan (#24), until an agent replaces it.
    const plan = ReviewPlan.parse(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')));
    expect(plan.origin).toBe('fallback');
    expect(summary).toContain(
      'Plan      fallback, 4 groups (an agent replaces plan.json with its own)',
    );
    expect(result.stdout).toBe(
      `${summary}\nWritten to ${join('.better-code-review', 'reviews', `commit-${head.slice(0, 7)}`)}\n`,
    );
    expect(readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8')).toMatch(
      /^\/\.better-code-review\/$/m,
    );
  });

  it('writes identical outputs on a rerun and lists the exclude entry once', async () => {
    const { repo, head } = signatureRepo();
    const out = (n: number) => join(repo.path, `out-${n}`);
    expect((await generate(repo.path, ['--commit', head, '--no-lsp'])).exitCode).toBe(0);
    expect((await generate(repo.path, ['--commit', head, '--no-lsp'])).exitCode).toBe(0);
    expect(
      (await generate(repo.path, ['--commit', head, '--no-lsp', '--out', out(1)])).exitCode,
    ).toBe(0);
    expect(
      (await generate(repo.path, ['--commit', head, '--no-lsp', '--out', out(2)])).exitCode,
    ).toBe(0);
    for (const file of [
      'changes.json',
      'graph.json',
      'planner-input.md',
      'plan.json',
      'summary.txt',
    ]) {
      expect(readFileSync(join(out(1), file), 'utf8')).toBe(
        readFileSync(join(out(2), file), 'utf8'),
      );
    }
    const exclude = readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/better-code-review/g)).toHaveLength(1);
  });

  it('shows context from a generated review with show', async () => {
    const { repo, head } = signatureRepo();
    const out = join(repo.path, 'out');
    expect((await generate(repo.path, ['--commit', head, '--no-lsp', '--out', out])).exitCode).toBe(
      0,
    );
    const graph = readOutputs(out).graph;
    const formatPrice = graph.nodes.find((n) => n.displayName === 'formatPrice')!;
    const cli = async (...argv: string[]) => {
      let stdout = '';
      let stderr = '';
      const exitCode = await run(['show', '--dir', out, ...argv], {
        cwd: repo.path,
        out: (t) => (stdout += t),
        err: (t) => (stderr += t),
      });
      return { exitCode, stdout, stderr };
    };

    const node = await cli(formatPrice.id);
    expect(node.exitCode).toBe(EXIT.ok);
    expect(node.stdout).toContain('Old side, src/price.ts:');
    // An unchanged file, read from Git at the snapshot.
    const file = await cli('--file', 'src/reexport.ts', '--lines', '1-1');
    expect(file.stdout).toBe(
      "# src/reexport.ts, new side\n\n1  export { formatPrice as fmt } from './price.ts';\n",
    );
    expect(await cli('n_0000000000000000')).toEqual({
      exitCode: EXIT.failed,
      stdout: '',
      stderr: 'no node n_0000000000000000 in this snapshot\n',
    });
  });

  it('names range and pull request outputs after their revisions', async () => {
    const { repo, base, head } = signatureRepo();
    repo.git('update-ref', 'refs/heads/main', base);
    repo.git('update-ref', 'refs/heads/feature', head);

    expect((await generate(repo.path, ['--range', 'main..feature', '--no-lsp'])).exitCode).toBe(0);
    const range = readOutputs(
      join(
        repo.path,
        '.better-code-review',
        'reviews',
        `range-${base.slice(0, 7)}-${head.slice(0, 7)}`,
      ),
    );
    expect(range.changes.target).toEqual({
      kind: 'range',
      base: 'main',
      head: 'feature',
      mode: 'direct',
    });

    const gh: GhRunner = () =>
      Promise.resolve(
        JSON.stringify({
          html_url: 'https://github.com/acme/shop/pull/12',
          title: 'Add currency',
          body: null,
          base: {
            ref: 'main',
            sha: base,
            repo: { full_name: 'acme/shop', html_url: 'https://github.com/acme/shop' },
          },
          head: { ref: 'feature', sha: head },
        }),
      );
    const pr = await generate(repo.path, ['--pr', '12', '--no-lsp'], { extract: { gh } });
    expect(pr.exitCode).toBe(0);
    const { changes, graph } = readOutputs(
      join(repo.path, '.better-code-review', 'reviews', 'pr-12'),
    );
    expect(changes.pullRequest?.title).toBe('Add currency');
    // Same snapshot as the range, so the same graph.
    expect(graph).toEqual(range.graph);
  });

  it('reviews the working tree, including untracked files unless told otherwise', async () => {
    const repo = new TestRepo();
    const head = repo.commit([], { 'a.ts': 'export function a() {\n  return 1;\n}\n' });
    repo.git('update-ref', 'refs/heads/main', head);
    repo.git('checkout-index', '--all', '--force');
    writeFileSync(join(repo.path, 'a.ts'), 'export function a() {\n  return 2;\n}\n');
    writeFileSync(join(repo.path, 'b.py'), 'def b():\n    return 1\n');

    const out = tempDir();
    expect((await generate(repo.path, ['--local', '--no-lsp', '--out', out])).exitCode).toBe(0);
    const all = readOutputs(out);
    expect(all.changes.files.map((f) => f.newPath)).toEqual(['a.ts', 'b.py']);

    const tracked = await generate(repo.path, [
      '--local',
      '--no-untracked',
      '--no-lsp',
      '--out',
      out,
    ]);
    expect(tracked.exitCode).toBe(0);
    const { changes, summary } = readOutputs(out);
    expect(changes.files.map((f) => f.newPath)).toEqual(['a.ts']);
    expect(changes.excludedUntrackedPaths).toEqual(['b.py']);
    expect(summary).toContain('1 untracked file not included');
  });

  it('gives unsupported-language and binary files file nodes', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], { 'main.rb': 'puts 1\n', 'logo.png': Buffer.from([0, 1, 2]) });
    const head = repo.commit([base], { 'main.rb': 'puts 2\n', 'logo.png': Buffer.from([0, 1, 3]) });
    const out = tempDir();
    expect((await generate(repo.path, ['--commit', head, '--no-lsp', '--out', out])).exitCode).toBe(
      0,
    );
    const { graph, summary } = readOutputs(out);
    expect(graph.nodes.map((n) => [n.path, n.kind]).sort()).toEqual([
      ['logo.png', 'file'],
      ['main.rb', 'file'],
    ]);
    expect(summary).toContain('content omitted: 1 binary');
    expect(summary).toContain('Analysis  2 git-only');
  });

  it('says how many files parsed partially (#93)', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], { 'a.ts': 'export const a = 1;\n' });
    const head = repo.commit([base], { 'a.ts': 'export const a = (1;\n' });
    const out = tempDir();
    expect((await generate(repo.path, ['--commit', head, '--no-lsp', '--out', out])).exitCode).toBe(
      0,
    );
    const { graph, summary } = readOutputs(out);
    expect(graph.files.map((f) => [f.path, f.partialParse])).toEqual([['a.ts', true]]);
    expect(summary).toContain('Analysis  1 structural (1 parsed partially)');
  });

  it('checks the head out for language servers and cleans up after', async () => {
    const { repo, head } = signatureRepo();
    const out = tempDir();
    // No server on an empty search path: each language reports it and the run still succeeds.
    const result = await generate(repo.path, ['--commit', head, '--out', out], {
      lsp: { searchPath: tempDir() },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Starting language servers');
    const { graph, summary } = readOutputs(out);
    expect(graph.languages.map((l) => [l.language, l.status])).toEqual([
      ['python', 'not-installed'],
      ['typescript', 'not-installed'],
    ]);
    expect(summary).toMatch(/python +not-installed/);
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('reports a failed run with exit code 1', async () => {
    const { repo } = signatureRepo();
    const result = await generate(repo.path, ['--commit', 'no-such-rev', '--no-lsp']);
    expect(result.exitCode).toBe(EXIT.failed);
    expect(result.stderr).toMatch(/^error: .*no-such-rev/m);
    expect(result.stdout).toBe('');
  });
});
