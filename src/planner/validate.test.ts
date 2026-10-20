import { describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
  type Analysed,
} from '../analysis/semantic/fixture.test-helper.ts';
import { gitSnapshotFiles, type SnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import { buildGraph } from '../graph/build.ts';
import type { ChangeSet } from '../schemas/changeset.ts';
import type { LineRef } from '../schemas/common.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { PLAN_SCHEMA_VERSION, UNGROUPED_TITLE, type ReviewPlan } from '../schemas/plan.ts';
import { validatePlan, type PlanError } from './validate.ts';

// The crafted invalid plans below are copies of a valid plan with one thing broken. The plan is
// over the signature fixture without LSP, so every code edge is `possible`.
const signature = (() => {
  let result: Promise<Analysed> | undefined;
  return () => (result ??= analyse(SIGNATURE_BASE, SIGNATURE_HEAD));
})();

interface Fixture {
  graph: ChangeGraph;
  changes: ChangeSet;
  files: SnapshotFiles;
  plan: ReviewPlan;
}

/** One group per file, in path order, each referencing the nodes of the next file. */
async function fixture(): Promise<Fixture> {
  const { repo, changes, structure, evidence } = await signature();
  const graph = buildGraph(changes, { structure, evidence });
  const paths = [...new Set(graph.nodes.map((n) => n.path))].sort();
  const groups = paths.map((path, i) => ({
    id: `g${i}`,
    title: path,
    description: `Changes in ${path}`,
    nodeIds: graph.nodes.filter((n) => n.path === path).map((n) => n.id),
    referenceNodeIds: graph.nodes.filter((n) => n.path === paths[i + 1]).map((n) => n.id),
    childGroupIds: [],
  }));
  const edge = graph.codeEdges[0]!;
  const record = graph.evidence.find((r) => r.id === edge.evidenceIds[0])!;
  const line: LineRef = {
    path: record.location.path,
    side: record.location.side,
    line: record.location.range.startLine,
  };
  const plan: ReviewPlan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    snapshotId: graph.snapshotId,
    origin: 'agent',
    fallbackReason: null,
    summary: 'Adds a currency parameter.',
    groups,
    groupOrder: groups.map((g) => g.id),
    edgeVerdicts: [
      { edgeId: edge.id, verdict: 'yes', via: 'direct', reason: 'Calls it.', citedLine: line },
    ],
    inferredRelationships: [
      {
        id: 'r1',
        from: graph.nodes[0]!.id,
        to: graph.nodes[1]!.id,
        kind: 'change-propagation',
        explanation: 'Updated together.',
        citedLines: [line],
      },
    ],
  };
  return { graph, changes, files: gitSnapshotFiles(repo.path, changes), plan };
}

const tamper = (plan: ReviewPlan, f: (p: ReviewPlan, g: ChangeGraph) => void, g: ChangeGraph) => {
  const copy = structuredClone(plan);
  f(copy, g);
  return copy;
};

async function errorsOf(data: unknown, { graph, files }: Fixture): Promise<PlanError[]> {
  const result = await validatePlan(data, graph, files);
  return result.valid ? [] : result.errors;
}

describe('validatePlan: valid plans', () => {
  it('pass unchanged, with overlapping groups through references', async () => {
    const f = await fixture();
    expect(f.plan.groups.length).toBeGreaterThan(1);
    const result = await validatePlan(structuredClone(f.plan), f.graph, f.files);
    expect(result).toEqual({ valid: true, plan: f.plan, ungroupedNodeIds: [] });
  });

  it('may cite lines of unchanged files, which `show --file` reads', async () => {
    const f = await fixture();
    expect(f.changes.files.map((file) => file.newPath)).not.toContain('tsconfig.json');
    const citing = tamper(
      f.plan,
      (p) =>
        p.inferredRelationships[0]!.citedLines.push({
          path: 'tsconfig.json',
          side: 'old',
          line: 1,
        }),
      f.graph,
    );
    expect(await errorsOf(citing, f)).toEqual([]);
  });

  it('allow one level of nesting, with only top-level groups in groupOrder', async () => {
    const f = await fixture();
    const nested = tamper(
      f.plan,
      (p) => {
        p.groups[0]!.childGroupIds = ['g1'];
        p.groupOrder = p.groupOrder.filter((id) => id !== 'g1');
      },
      f.graph,
    );
    expect(await errorsOf(nested, f)).toEqual([]);
  });

  it('put homeless nodes in a new Ungrouped group, last in groupOrder', async () => {
    const f = await fixture();
    const homeless = f.plan.groups[0]!.nodeIds;
    const partial = tamper(f.plan, (p) => (p.groups[0]!.nodeIds = []), f.graph);
    const result = await validatePlan(partial, f.graph, f.files);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.ungroupedNodeIds).toEqual(homeless);
    expect(result.plan.groupOrder.at(-1)).toBe('ungrouped');
    expect(result.plan.groups.at(-1)).toMatchObject({
      id: 'ungrouped',
      title: UNGROUPED_TITLE,
      nodeIds: homeless,
    });
    // Every hunk is then visible in some group.
    const placed = new Set(result.plan.groups.flatMap((g) => g.nodeIds));
    const hunks = new Set(f.graph.nodes.filter((n) => placed.has(n.id)).flatMap((n) => n.hunkIds));
    expect(hunks.size).toBe(f.changes.files.flatMap((file) => file.hunks).length);
  });

  it("add homeless nodes to the plan's own Ungrouped group", async () => {
    const f = await fixture();
    const homeless = f.plan.groups[1]!.nodeIds;
    const partial = tamper(
      f.plan,
      (p) => {
        p.groups[1]!.nodeIds = [];
        p.groups.push({
          id: 'ungrouped',
          title: 'Leftovers',
          description: '',
          nodeIds: [],
          referenceNodeIds: [],
          childGroupIds: [],
        });
        p.groupOrder.unshift('ungrouped');
      },
      f.graph,
    );
    const result = await validatePlan(partial, f.graph, f.files);
    expect(result.valid && result.plan.groups.find((g) => g.id === 'ungrouped')).toMatchObject({
      title: 'Leftovers',
      nodeIds: homeless,
    });
    expect(result.valid && result.plan.groupOrder).toEqual(partial.groupOrder);
  });
});

describe('validatePlan: crafted invalid plans fail', () => {
  const unknownNode = 'n_0000000000000000';
  const cases: [
    string,
    (p: ReviewPlan, g: ChangeGraph) => void,
    Omit<PlanError, 'message'>,
    RegExp,
  ][] = [
    [
      'code text in an extra field',
      (p) => Object.assign(p.groups[0]!, { code: 'export function x() {}' }),
      { path: '/groups/0', code: 'schema' },
      /Unrecognized key.*"code".*Remove them/,
    ],
    [
      'a verdict upgrading an edge to verified',
      (p) => Object.assign(p.edgeVerdicts[0]!, { verdict: 'verified' }),
      { path: '/edgeVerdicts/0/verdict', code: 'schema' },
      /yes.*no.*unsure/,
    ],
    [
      'a provenance on a verdict',
      (p) => Object.assign(p.edgeVerdicts[0]!, { provenance: 'verified' }),
      { path: '/edgeVerdicts/0', code: 'schema' },
      /provenance/,
    ],
    [
      'another schema version',
      (p) => Object.assign(p, { schemaVersion: 2 }),
      { path: '/schemaVersion', code: 'schema' },
      /1/,
    ],
    [
      'another snapshot',
      (p) => (p.snapshotId = '0'.repeat(64)),
      { path: '/snapshotId', code: 'snapshot' },
      /^must be [0-9a-f]{64}, the graph's snapshot$/,
    ],
    [
      'an agent plan with a fallback reason',
      (p) => (p.fallbackReason = 'none'),
      { path: '/fallbackReason', code: 'origin' },
      /must be null/,
    ],
    [
      'a duplicate group ID',
      (p) => (p.groups[1]!.id = 'g0'),
      { path: '/groups/1/id', code: 'duplicate-id' },
      /^group ID g0 is used twice/,
    ],
    [
      'a nonexistent home node',
      (p) => (p.groups[0]!.nodeIds = [unknownNode]),
      { path: '/groups/0/nodeIds/0', code: 'unknown-id' },
      /^node n_0+ is not in graph\.json$/,
    ],
    [
      'a nonexistent reference node',
      (p) => (p.groups[0]!.referenceNodeIds = [unknownNode]),
      { path: '/groups/0/referenceNodeIds/0', code: 'unknown-id' },
      /^node n_0+ is not in graph\.json$/,
    ],
    [
      'a node with two homes',
      (p) => (p.groups[1]!.nodeIds = [p.groups[0]!.nodeIds[0]!]),
      { path: '/groups/1/nodeIds/0', code: 'multiple-homes' },
      /already has its home in group g0; move it to this group's referenceNodeIds$/,
    ],
    [
      'a node listed twice in one group',
      (p) => (p.groups[0]!.nodeIds = [p.groups[0]!.nodeIds[0]!, p.groups[0]!.nodeIds[0]!]),
      { path: '/groups/0/nodeIds/1', code: 'multiple-homes' },
      /is listed twice in group g0$/,
    ],
    [
      'a node both home and reference in one group',
      (p) => (p.groups[0]!.referenceNodeIds = [p.groups[0]!.nodeIds[0]!]),
      { path: '/groups/0/referenceNodeIds/0', code: 'multiple-homes' },
      /already in this group's nodeIds/,
    ],
    [
      'a nonexistent child group',
      (p) => (p.groups[0]!.childGroupIds = ['nope']),
      { path: '/groups/0/childGroupIds/0', code: 'unknown-id' },
      /^group nope is not in groups$/,
    ],
    [
      'a group containing itself',
      (p) => (p.groups[0]!.childGroupIds = ['g0']),
      { path: '/groups/0/childGroupIds/0', code: 'nesting' },
      /cannot contain itself/,
    ],
    [
      'two levels of nesting',
      (p) => {
        p.groups[0]!.childGroupIds = ['g1'];
        p.groups[1]!.childGroupIds = ['g2'];
      },
      { path: '/groups/0/childGroupIds/0', code: 'nesting' },
      /one level only/,
    ],
    [
      'a group with two parents',
      (p) => {
        p.groups[0]!.childGroupIds = ['g2'];
        p.groups[1]!.childGroupIds = ['g2'];
      },
      { path: '/groups/1/childGroupIds/0', code: 'nesting' },
      /already a child of group g0/,
    ],
    [
      'a nested Ungrouped group',
      (p) => {
        p.groups[1]!.id = 'ungrouped';
        p.groupOrder[1] = 'ungrouped';
        p.groups[0]!.childGroupIds = ['ungrouped'];
      },
      { path: '/groups/0/childGroupIds/0', code: 'reserved-id' },
      /must be top-level/,
    ],
    [
      'a nonexistent group in groupOrder',
      (p) => p.groupOrder.unshift('nope'),
      { path: '/groupOrder/0', code: 'unknown-id' },
      /^group nope is not in groups$/,
    ],
    [
      'a child group in groupOrder',
      (p) => (p.groups[0]!.childGroupIds = ['g1']),
      { path: '/groupOrder/1', code: 'group-order' },
      /is a child of g0; list only top-level groups/,
    ],
    [
      'a group listed twice in groupOrder',
      (p) => p.groupOrder.unshift('g0'),
      { path: '/groupOrder/1', code: 'group-order' },
      /listed twice/,
    ],
    [
      'a top-level group missing from groupOrder',
      (p) => p.groupOrder.splice(2, 1),
      { path: '/groupOrder', code: 'group-order' },
      /^top-level group g2 is missing; add it$/,
    ],
    [
      'a verdict on a new edge',
      (p) => (p.edgeVerdicts[0]!.edgeId = 'e_0000000000000000'),
      { path: '/edgeVerdicts/0/edgeId', code: 'unknown-id' },
      /verdicts only label existing code edges/,
    ],
    [
      'a verdict on a verified edge',
      (_, g) => (g.codeEdges[0]!.provenance = 'verified'),
      { path: '/edgeVerdicts/0/edgeId', code: 'verdict' },
      /is already verified; only possible edges take a verdict/,
    ],
    [
      'two verdicts on one edge',
      (p) => p.edgeVerdicts.push(p.edgeVerdicts[0]!),
      { path: '/edgeVerdicts/1/edgeId', code: 'verdict' },
      /has two verdicts/,
    ],
    [
      'a way the call reaches the target on a no',
      (p) => (p.edgeVerdicts[0]!.verdict = 'no'),
      { path: '/edgeVerdicts/0/via', code: 'verdict' },
      /must be null when the verdict is no/,
    ],
    [
      'a verdict citing a line past the end of the file',
      (p) => (p.edgeVerdicts[0]!.citedLine.line = 999),
      { path: '/edgeVerdicts/0/citedLine', code: 'citation' },
      /^src\/\w+\.ts \((old|new)\) has \d+ lines, so it has no line 999$/,
    ],
    [
      'a verdict citing a file not in the change',
      (p) => (p.edgeVerdicts[0]!.citedLine.path = 'src/elsewhere.ts'),
      { path: '/edgeVerdicts/0/citedLine', code: 'citation' },
      /^src\/elsewhere\.ts \((old|new)\) is not a text file in the snapshot on that side$/,
    ],
    [
      'a duplicate relationship ID',
      (p) => p.inferredRelationships.push(p.inferredRelationships[0]!),
      { path: '/inferredRelationships/1/id', code: 'duplicate-id' },
      /^relationship ID r1 is used twice/,
    ],
    [
      'a relationship to a nonexistent node',
      (p) => (p.inferredRelationships[0]!.to = unknownNode),
      { path: '/inferredRelationships/0/to', code: 'unknown-id' },
      /^node n_0+ is not in graph\.json$/,
    ],
    [
      'a relationship citing a fabricated line',
      (p) => p.inferredRelationships[0]!.citedLines.push({ path: 'x.ts', side: 'new', line: 1 }),
      { path: '/inferredRelationships/0/citedLines/1', code: 'citation' },
      /^x\.ts \(new\) is not a text file in the snapshot/,
    ],
  ];

  it('the fixture has the shape these cases assume', async () => {
    const f = await fixture();
    expect(f.plan.groups.slice(0, 3).map((g) => g.id)).toEqual(['g0', 'g1', 'g2']);
    expect(f.plan.groups.every((g) => g.nodeIds.length > 0)).toBe(true);
  });

  it.each(cases)('%s', async (_, breakIt, expected, message) => {
    const f = await fixture();
    const graph = structuredClone(f.graph);
    const broken = tamper(f.plan, breakIt, graph);
    const errors = await errorsOf(broken, { ...f, graph });
    const at = errors.find((e) => e.path === expected.path && e.code === expected.code);
    expect(at, JSON.stringify(errors)).toBeDefined();
    expect(at!.message).toMatch(message);
  });

  it('reports every error at once', async () => {
    const f = await fixture();
    const broken = tamper(
      f.plan,
      (p) => {
        p.groups[0]!.nodeIds.unshift(unknownNode);
        p.edgeVerdicts[0]!.edgeId = 'e_0000000000000000';
      },
      f.graph,
    );
    expect((await errorsOf(broken, f)).map((e) => e.path)).toEqual([
      '/groups/0/nodeIds/0',
      '/edgeVerdicts/0/edgeId',
    ]);
  });
});
