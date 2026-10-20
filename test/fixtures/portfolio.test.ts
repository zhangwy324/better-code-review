// Every portfolio fixture (README.md) through `generate --no-lsp`, checked against its expected
// facts, plus what holds for all of them (Milestone 1 acceptance, #21): full hunk coverage,
// nothing verified, exact diffs, stable IDs, source mapping and capability reporting, and a
// planner input (#22) that lists the whole graph within its budget.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generate } from '../../src/cli/generate.ts';
import { hunkCoverage } from '../../src/graph/index.ts';
import type { Fixture } from './fixture.ts';
import { expectExactDiff, expectSourceMapping, facts } from './facts.ts';
import { FIXTURES } from './index.ts';
import { buildFixtureRepo } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-fixtures-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Builds `fixture` in `dir` and runs `generate --no-lsp` on its head commit. */
async function generateFixture(dir: string, fixture: Fixture) {
  const { head } = buildFixtureRepo(join(dir, 'repo'), fixture);
  const out = join(dir, 'out');
  const result = await generate({
    repositoryPath: join(dir, 'repo'),
    target: { kind: 'commit', commit: head },
    outputDirectory: out,
    analysis: { useLsp: false, allowProjectCodeExecution: false },
  });
  const read = (name: string) => readFileSync(join(out, name), 'utf8');
  return {
    ...result,
    written: ['changes.json', 'graph.json', 'planner-input.md', 'summary.txt'].map(read),
  };
}

describe.each(FIXTURES)('fixture $name', (fixture) => {
  it('matches its expected facts with no language server', async () => {
    const { changeSet, graph, planner, summary, written } = await generateFixture(
      join(root, fixture.name),
      fixture,
    );

    const { mapped, total } = hunkCoverage(graph, changeSet);
    expect(mapped).toBe(total);
    expect(graph.codeEdges.filter((e) => e.provenance === 'verified')).toEqual([]);

    const sorted = (l: string[] = []) => [...l].sort();
    const { expected } = fixture;
    expect(facts(changeSet, graph)).toEqual({
      files: sorted(expected.files),
      nodes: sorted(expected.nodes),
      edges: sorted(expected.edges),
      caps: sorted(expected.caps),
    });

    expectExactDiff(changeSet, fixture.base, fixture.head);
    expectSourceMapping(changeSet, graph);

    // Each parsed language says its edges are possible only, and why (D11).
    const languages = [...new Set(graph.files.flatMap((f) => f.language ?? []))].sort();
    expect(graph.languages.map((l) => `${l.language} ${l.side} ${l.status}`).sort()).toEqual(
      languages.map((l) => `${l} new disabled`),
    );
    for (const l of graph.languages) {
      expect(l.guidance).toMatch(/possible only/);
      expect(summary).toMatch(new RegExp(`${l.language} +disabled`));
    }

    // The planner input (#22) lists every node and hunk, and keeps to its budget.
    for (const node of graph.nodes) expect(planner.text).toContain(`- ${node.id} `);
    for (const file of changeSet.files) {
      for (const hunk of file.hunks) expect(planner.text).toContain(`- ${hunk.id}`);
    }
    expect(planner.estimatedTokens).toBeLessThanOrEqual(planner.tokenBudget);

    // Stable IDs: a second, separately built repository gives byte-identical outputs.
    const again = await generateFixture(join(root, `${fixture.name}-again`), fixture);
    expect(again.written).toEqual(written);
  }, 120_000);
});
