// Every portfolio fixture (README.md) through `generate --no-lsp`, checked against its expected
// facts, plus the invariants that hold for all of them: full hunk coverage and nothing verified.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generate } from '../../src/cli/generate.ts';
import { hunkCoverage } from '../../src/graph/index.ts';
import type { ChangeGraph, ChangeSet } from '../../src/schemas/index.ts';
import type { ExpectedFacts } from './fixture.ts';
import { FIXTURES } from './index.ts';
import { buildFixtureRepo } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-fixtures-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The graph's facts in the ExpectedFacts notation, sorted. */
function facts(changeSet: ChangeSet, graph: ChangeGraph): Required<ExpectedFacts> {
  // A display name shared by several nodes gets its path, so the facts say which one is meant.
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(n.displayName, (counts.get(n.displayName) ?? 0) + 1);
  const label = new Map(
    graph.nodes.map((n) => [
      n.id,
      counts.get(n.displayName)! > 1 ? `${n.displayName} [${n.path}]` : n.displayName,
    ]),
  );
  const byEntity = new Map(graph.nodes.map((n) => [n.entityId, label.get(n.id)!]));
  const omitted = new Map(changeSet.files.map((f) => [f.newPath ?? f.oldPath, f.contentOmitted]));
  return {
    files: graph.files
      .map((f) => {
        const reasons = new Set([f.skipped, omitted.get(f.path)]);
        return [f.path, f.capabilityTier, f.test === null ? null : 'test', ...reasons]
          .filter(Boolean)
          .join(' ');
      })
      .sort(),
    nodes: graph.nodes.map((n) => `${n.kind} ${label.get(n.id)}`).sort(),
    edges: graph.codeEdges
      .map((e) => {
        const from = e.granularity === 'entity' ? label.get(e.from) : e.fromPath;
        return `${from} ${e.relation} ${label.get(e.to)} (${e.sides})`;
      })
      .sort(),
    caps: graph.caps
      .map((c) => `${byEntity.get(c.entityId)} ${c.relation} ${c.shown}/${c.total}`)
      .sort(),
  };
}

describe.each(FIXTURES)('fixture $name', (fixture) => {
  it('matches its expected facts with no language server', async () => {
    const dir = join(root, fixture.name);
    const { head } = buildFixtureRepo(join(dir, 'repo'), fixture);
    const { changeSet, graph } = await generate({
      repositoryPath: join(dir, 'repo'),
      target: { kind: 'commit', commit: head },
      outputDirectory: join(dir, 'out'),
      analysis: { useLsp: false, allowProjectCodeExecution: false },
    });

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
  }, 120_000);
});
