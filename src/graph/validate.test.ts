import { describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
  type Analysed,
} from '../analysis/semantic/fixture.test-helper.ts';
import { analyzeStructure } from '../analysis/structural/analyze.ts';
import { extractChangeSet } from '../git/extract.ts';
import { TestRepo } from '../git/test-repo.test-helper.ts';
import type { ChangeSet } from '../schemas/changeset.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { buildGraph } from './build.ts';
import { assertValidGraph, graphViolations, hunkCoverage, InvariantError } from './validate.ts';

// The crafted invalid graphs below are copies of a valid builder output with one thing broken.
// The signature fixture without LSP has every kind of record: file, module-less symbol nodes,
// possible edges and the evidence they cite.
const signature = (() => {
  let result: Promise<Analysed> | undefined;
  return () => (result ??= analyse(SIGNATURE_BASE, SIGNATURE_HEAD));
})();

async function fixture(): Promise<{ graph: ChangeGraph; changes: ChangeSet }> {
  const { changes, structure, evidence } = await signature();
  return { graph: buildGraph(changes, { structure, evidence }), changes: structuredClone(changes) };
}

const tamper = (graph: ChangeGraph, f: (g: ChangeGraph) => void) => {
  const copy = structuredClone(graph);
  f(copy);
  return copy;
};

describe('graphViolations: builder outputs pass', () => {
  it('at every capability tier of the signature fixture', async () => {
    const { changes, structure, evidence } = await signature();
    for (const graph of [
      buildGraph(changes),
      buildGraph(changes, { structure }),
      buildGraph(changes, { structure, evidence }),
    ]) {
      expect(graphViolations(graph, changes)).toEqual([]);
      expect(hunkCoverage(graph, changes)).toEqual({ mapped: 12, total: 12 });
    }
  });

  it('with binary, mode-only and empty changes', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], { 'logo.png': Buffer.from([0x89, 0x50, 0, 1]), 'run.sh': 'x\n' });
    const head = repo.commit([base], {
      'logo.png': Buffer.from([0x89, 0x50, 0, 2]),
      'run.sh': { mode: '100755', content: 'x\n' },
    });
    for (const commit of [head, repo.commit([head], {})]) {
      const changes = await extractChangeSet(repo.path, { kind: 'commit', commit });
      const graph = buildGraph(changes, { structure: await analyzeStructure(changes) });
      expect(graphViolations(graph, changes)).toEqual([]);
      expect(hunkCoverage(graph, changes)).toEqual({ mapped: 0, total: 0 });
    }
  });

  it('a verified edge citing a confirmed LSP record', async () => {
    const { graph, changes } = await fixture();
    const verified = tamper(graph, (g) => {
      const edge = g.codeEdges[0]!;
      edge.provenance = 'verified';
      const record = g.evidence.find((r) => r.id === edge.evidenceIds[0])!;
      record.method = 'lsp';
      record.outcome = 'confirmed';
    });
    expect(graphViolations(verified, changes)).toEqual([]);
  });
});

describe('graphViolations: crafted invalid graphs fail', () => {
  const cases: [string, (g: ChangeGraph, c: ChangeSet) => void, RegExp][] = [
    [
      'another snapshot',
      (g) => (g.snapshotId = '0'.repeat(64)),
      /^graph is for snapshot 0+, not [0-9a-f]{64}$/,
    ],
    [
      'a duplicate hunk ID in the change',
      (_, c) => (c.files[1]!.hunks[0]!.id = c.files[0]!.hunks[0]!.id),
      /^hunk ID h_\w+ is not unique$/,
    ],
    [
      'a duplicate node ID',
      (g) => (g.nodes[1]!.id = g.nodes[0]!.id),
      /^node ID n_\w+ is not unique$/,
    ],
    [
      'a duplicate edge ID',
      (g) => (g.codeEdges[1]!.id = g.codeEdges[0]!.id),
      /^edge ID e_\w+ is not unique$/,
    ],
    [
      'a duplicate evidence ID',
      (g) => g.evidence.push(g.evidence[0]!),
      /^evidence record ID ev_\w+ is not unique$/,
    ],
    [
      'a hunk on no node',
      (g) => (g.nodes[0]!.hunkIds = []),
      /^hunk h_\w+ is on no node and not in uncoveredHunkIds$/,
    ],
    [
      'a hunk both on a node and uncovered',
      (g) => g.uncoveredHunkIds.push(g.nodes[0]!.hunkIds[0]!),
      /^hunk h_\w+ is in uncoveredHunkIds but on a node$/,
    ],
    [
      'a node citing an unknown hunk',
      (g) => g.nodes[0]!.hunkIds.push('h_0000000000000000'),
      /^node n_\w+ cites hunk h_0+, which is not in the change$/,
    ],
    [
      'an unknown uncovered hunk',
      (g) => g.uncoveredHunkIds.push('h_0000000000000000'),
      /^uncoveredHunkIds lists hunk h_0+, which is not in the change$/,
    ],
    [
      'an edge to a missing node',
      (g) => (g.codeEdges[0]!.to = 'n_0000000000000000'),
      /^edge e_\w+ points to node n_0+, which is missing$/,
    ],
    [
      'an edge from a missing node',
      (g) => {
        const edge = g.codeEdges[0]!;
        if (edge.granularity === 'entity') edge.from = 'n_0000000000000000';
      },
      /^edge e_\w+ comes from node n_0+, which is missing$/,
    ],
    [
      'a test-file edge from an unknown file',
      (g) => {
        const { id, to, relation, provenance, evidenceIds } = g.codeEdges[0]!;
        const fromPath = 'nowhere.test.ts';
        g.codeEdges[0] = {
          id,
          granularity: 'test-file',
          fromPath,
          to,
          relation,
          provenance,
          evidenceIds,
        };
      },
      /^edge e_\w+ comes from nowhere\.test\.ts, which is not a changed file$/,
    ],
    [
      'an edge citing missing evidence',
      (g) => g.codeEdges[0]!.evidenceIds.push('ev_0000000000000000'),
      /^edge e_\w+ cites evidence ev_0+, which is missing$/,
    ],
    [
      "an edge citing another edge's evidence",
      (g) => g.codeEdges[0]!.evidenceIds.push(g.codeEdges[1]!.evidenceIds[0]!),
      /^edge e_\w+ cites evidence ev_\w+, which is about another edge$/,
    ],
    [
      'an edge citing evidence of another relation',
      (g) => (g.codeEdges[0]!.relation = 'references'),
      /^edge e_\w+ cites evidence ev_\w+, which is about another edge$/,
    ],
    [
      'a verified edge with only candidate evidence',
      (g) => (g.codeEdges[0]!.provenance = 'verified'),
      /^edge e_\w+ is verified but cites no confirmed lsp evidence$/,
    ],
    [
      'a verified edge whose LSP record was rejected',
      (g) => {
        const edge = g.codeEdges[0]!;
        edge.provenance = 'verified';
        for (const r of g.evidence.filter((r) => edge.evidenceIds.includes(r.id))) {
          r.method = 'lsp';
          r.outcome = 'rejected';
        }
      },
      /^edge e_\w+ is verified but cites no confirmed lsp evidence$/,
    ],
    [
      'evidence about an entity with no node',
      (g) => (g.evidence[0]!.sourceEntityId = 'ent_0000000000000000'),
      /^evidence ev_\w+ cites entity ent_0+, which has no node$/,
    ],
    [
      'evidence in a file that is not in the change',
      (g) => (g.evidence[0]!.location.path = 'src/email.ts'),
      /^evidence ev_\w+ is at src\/email\.ts \((old|new)\), which is not a changed file on that side$/,
    ],
    [
      'evidence past the end of its file',
      (g) => (g.evidence[0]!.location.range = { startLine: 99, endLine: 99 }),
      /^evidence ev_\w+ is at src\/\w+\.ts:99 \((old|new)\), past the file's \d+ lines$/,
    ],
    [
      'a fan-out cap on an entity with no node',
      (g) =>
        g.caps.push({ entityId: 'ent_0000000000000000', relation: 'calls', shown: 1, total: 2 }),
      /^a fan-out cap names entity ent_0+, which has no node$/,
    ],
  ];

  it.each(cases)('%s', async (_, breakIt, reason) => {
    const { graph, changes } = await fixture();
    const broken = tamper(graph, (g) => breakIt(g, changes));
    // One break can cause others downstream (an edge citing a moved record, say).
    expect(graphViolations(broken, changes)).toContainEqual(expect.stringMatching(reason));
  });

  it('assertValidGraph throws one InvariantError listing every violation', async () => {
    const { graph, changes } = await fixture();
    const broken = tamper(graph, (g) => {
      g.nodes[0]!.hunkIds = [];
      g.codeEdges[0]!.provenance = 'verified';
    });
    expect(() => assertValidGraph(graph, changes)).not.toThrow();
    const error = (() => {
      try {
        assertValidGraph(broken, changes);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(InvariantError);
    expect((error as InvariantError).violations).toHaveLength(2);
    expect((error as InvariantError).message).toMatch(/^graph breaks 2 invariant\(s\):\n- hunk/);
  });
});

describe('hunkCoverage', () => {
  it('counts changed hunks, not the nodes that hold them', async () => {
    const { graph, changes } = await fixture();
    // A second node on the same hunks (as a context node would be) adds nothing.
    const doubled = tamper(graph, (g) =>
      g.nodes.push({ ...g.nodes[0]!, id: 'n_0000000000000000' }),
    );
    expect(hunkCoverage(doubled, changes)).toEqual({ mapped: 12, total: 12 });
    // A hunk moved to uncoveredHunkIds is not mapped, but still counted.
    const unmapped = tamper(graph, (g) => {
      g.uncoveredHunkIds = g.nodes[0]!.hunkIds;
      g.nodes[0]!.hunkIds = [];
    });
    expect(graphViolations(unmapped, changes)).toEqual([]);
    expect(hunkCoverage(unmapped, changes)).toEqual({ mapped: 11, total: 12 });
  });
});
