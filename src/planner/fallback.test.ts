import { describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
} from '../analysis/semantic/fixture.test-helper.ts';
import { gitSnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import { buildGraph } from '../graph/build.ts';
import { UNGROUPED_GROUP_ID, UNGROUPED_TITLE } from '../schemas/plan.ts';
import { fallbackPlan, NO_AGENT_REASON } from './fallback.ts';
import { validatePlan } from './validate.ts';

// The signature fixture without LSP: a TypeScript and a Python cluster joined by `possible`
// edges, plus nodes with no edge and no other change in their file. The whole portfolio is
// checked in test/fixtures/portfolio.test.ts.
async function signature() {
  const { repo, changes, structure, evidence } = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
  return {
    graph: buildGraph(changes, { structure, evidence }),
    files: gitSnapshotFiles(repo.path, changes),
  };
}

describe('fallbackPlan', () => {
  it('groups nodes joined by code edges or a shared file, and leaves the rest ungrouped', async () => {
    const { graph } = await signature();
    const plan = fallbackPlan(graph);
    expect(plan).toMatchObject({
      snapshotId: graph.snapshotId,
      origin: 'fallback',
      fallbackReason: NO_AGENT_REASON,
      groupOrder: ['g1', 'g2', UNGROUPED_GROUP_ID],
      edgeVerdicts: [],
      inferredRelationships: [],
    });
    expect(plan.groups.map((g) => g.title)).toEqual([
      'tax and related changes',
      'formatPrice and related changes',
      UNGROUPED_TITLE,
    ]);

    // Every node has exactly one home, and an edge never crosses groups.
    const homes = new Map(plan.groups.flatMap((g) => g.nodeIds.map((id) => [id, g.id])));
    expect(plan.groups.flatMap((g) => g.nodeIds)).toHaveLength(graph.nodes.length);
    expect(homes.size).toBe(graph.nodes.length);
    for (const e of graph.codeEdges) {
      if (e.granularity === 'entity') expect(homes.get(e.from)).toBe(homes.get(e.to));
    }
    // An ungrouped node has no edge and no other changed node in its file.
    for (const id of plan.groups.at(-1)!.nodeIds) {
      const node = graph.nodes.find((n) => n.id === id)!;
      expect(graph.codeEdges.filter((e) => e.to === id || ('from' in e && e.from === id))).toEqual(
        [],
      );
      expect(graph.nodes.filter((n) => n.path === node.path)).toEqual([node]);
    }
  });

  it('passes the validator unchanged, with no node left to place', async () => {
    const { graph, files } = await signature();
    const plan = fallbackPlan(graph, 'The agent plan failed validation.');
    expect(plan.fallbackReason).toBe('The agent plan failed validation.');
    expect(await validatePlan(structuredClone(plan), graph, files)).toEqual({
      valid: true,
      plan,
      ungroupedNodeIds: [],
    });
  });

  it('is deterministic', async () => {
    const { graph } = await signature();
    expect(fallbackPlan(structuredClone(graph))).toEqual(fallbackPlan(graph));
  });

  it('groups by file alone when there are no code edges', async () => {
    const { graph } = await signature();
    const bare = { ...graph, codeEdges: [], evidence: [] };
    const plan = fallbackPlan(bare);
    const byFile = new Set(
      graph.nodes
        .filter((n, _, all) => all.some((m) => m !== n && m.path === n.path))
        .map((n) => n.path),
    );
    expect(plan.groups.filter((g) => g.id !== UNGROUPED_GROUP_ID).map((g) => g.title)).toEqual(
      [...byFile].map((path) => `Changes in ${path}`),
    );
    expect(plan.groupOrder.at(-1)).toBe(UNGROUPED_GROUP_ID);
  });

  it('makes no groups for an empty graph', async () => {
    const { graph } = await signature();
    const plan = fallbackPlan({ ...graph, nodes: [], codeEdges: [], evidence: [] });
    expect(plan.groups).toEqual([]);
    expect(plan.groupOrder).toEqual([]);
  });
});
