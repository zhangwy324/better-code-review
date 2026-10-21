import { describe, expect, it } from 'vitest';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
} from '../analysis/semantic/fixture.test-helper.ts';
import { gitSnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import { buildGraph } from '../graph/build.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { UNGROUPED_GROUP_ID } from '../schemas/plan.ts';
import { fallbackPlan, NO_AGENT_REASON } from './fallback.ts';
import { validatePlan } from './validate.ts';

// The signature fixture without LSP: a TypeScript and a Python cluster joined by `possible`
// edges, plus a code node and a config file with no edge and no other change in their file. The whole portfolio is
// checked in test/fixtures/portfolio.test.ts.
async function signature() {
  const { repo, changes, structure, evidence } = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
  return {
    graph: buildGraph(changes, { structure, evidence }),
    files: gitSnapshotFiles(repo.path, changes),
  };
}

const name = (graph: ChangeGraph, id: string) => graph.nodes.find((n) => n.id === id)!.displayName;

describe('fallbackPlan', () => {
  it('groups nodes joined by code edges or a shared file, each lone change on its own', async () => {
    const { graph } = await signature();
    const plan = fallbackPlan(graph);
    expect(plan).toMatchObject({
      snapshotId: graph.snapshotId,
      origin: 'fallback',
      fallbackReason: NO_AGENT_REASON,
      groupOrder: ['g1', 'g2', 'g3', 'g4'],
      edgeVerdicts: [],
      inferredRelationships: [],
    });
    expect(plan.groups.map((g) => g.title)).toEqual([
      'tax and related changes',
      'formatPrice and related changes',
      'Changes in src/legacyLabel.ts',
      'Other changed files',
    ]);
    expect(plan.groups.at(-1)!.nodeIds.map((id) => name(graph, id))).toEqual(['config.json']);

    // Every node has exactly one home, and an edge never crosses groups.
    const homes = new Map(plan.groups.flatMap((g) => g.nodeIds.map((id) => [id, g.id])));
    expect(plan.groups.flatMap((g) => g.nodeIds)).toHaveLength(graph.nodes.length);
    expect(homes.size).toBe(graph.nodes.length);
    for (const e of graph.codeEdges) {
      if (e.granularity === 'entity') expect(homes.get(e.from)).toBe(homes.get(e.to));
    }
    expect(plan.groups.map((g) => g.id)).not.toContain(UNGROUPED_GROUP_ID);
  });

  it('puts each callee before its callers', async () => {
    const { graph } = await signature();
    const [tax, price] = fallbackPlan(graph).groups;
    expect(tax!.nodeIds.map((id) => name(graph, id))[0]).toBe('tax');
    expect(price!.nodeIds.map((id) => name(graph, id))[0]).toBe('formatPrice');
    // Every edge inside a group points backwards in its reading order.
    for (const group of [tax!, price!]) {
      for (const e of graph.codeEdges) {
        if (e.granularity !== 'entity' || !group.nodeIds.includes(e.to)) continue;
        expect(group.nodeIds.indexOf(e.to)).toBeLessThan(group.nodeIds.indexOf(e.from));
      }
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
    const code = [...new Set(graph.nodes.filter((n) => n.kind !== 'file').map((n) => n.path))];
    expect(plan.groups.map((g) => g.title)).toEqual([
      ...code.map((path) => `Changes in ${path}`),
      'Other changed files',
    ]);
  });

  it('makes no groups for an empty graph', async () => {
    const { graph } = await signature();
    const plan = fallbackPlan({ ...graph, nodes: [], codeEdges: [], evidence: [] });
    expect(plan.groups).toEqual([]);
    expect(plan.groupOrder).toEqual([]);
  });
});
