// The deterministic fallback plan (#24, design reference §8.1, §10.8; MVP spec D1, D8): a plan
// made from the graph alone, so the renderer never depends on a model. `generate` writes it as
// plan.json, and the agent replaces it with its own (#25). It is also the plan to use when the
// agent's plan still fails validation after the repair loop, with `reason` saying so.
//
// Clustering: two nodes belong together when a code edge joins them (any provenance or side), or
// when they are in the same file. A test-file edge joins its target to the test file's nodes.
// Each cluster of two or more nodes is a group; a node joined to nothing goes into the
// `ungrouped` group ("Ungrouped / requires review"), last. The plan adds no verdicts and no
// inferred relationships, so every candidate edge stays `possible`.
//
// Groups and their nodes follow the graph's node order, so the same graph always gives the same
// plan. The plan passes `validatePlan()` unchanged: every node already has a home.
import type { ChangeGraph, ChangeNode } from '../schemas/graph.ts';
import {
  PLAN_SCHEMA_VERSION,
  UNGROUPED_GROUP_ID,
  UNGROUPED_TITLE,
  type ReviewGroup,
  type ReviewPlan,
} from '../schemas/plan.ts';
import { count, list } from '../text/index.ts';

/** The `fallbackReason` of a plan made because no agent was involved. */
export const NO_AGENT_REASON = 'No agent wrote a plan, so the changes were grouped without AI.';

export function fallbackPlan(graph: ChangeGraph, reason: string = NO_AGENT_REASON): ReviewPlan {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  // Union-find over node indices; a root is always its cluster's first node in graph order.
  const parent = graph.nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };

  const firstInFile = new Map<string, number>();
  graph.nodes.forEach((node, i) => {
    const first = firstInFile.get(node.path);
    if (first === undefined) firstInFile.set(node.path, i);
    else join(first, i);
  });
  for (const edge of graph.codeEdges) {
    const from =
      edge.granularity === 'entity' ? index.get(edge.from) : firstInFile.get(edge.fromPath);
    const to = index.get(edge.to);
    if (from !== undefined && to !== undefined) join(from, to);
  }

  const clusters = new Map<number, ChangeNode[]>();
  graph.nodes.forEach((node, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), node]);
  });

  const groups: ReviewGroup[] = [];
  const alone: string[] = [];
  for (const nodes of clusters.values()) {
    if (nodes.length === 1) alone.push(nodes[0]!.id);
    else groups.push(group(`g${groups.length + 1}`, nodes, graph));
  }
  if (alone.length > 0) {
    groups.push({
      id: UNGROUPED_GROUP_ID,
      title: UNGROUPED_TITLE,
      description: 'Changes with no code edge to another change and no other change in their file.',
      nodeIds: alone,
      referenceNodeIds: [],
      childGroupIds: [],
    });
  }

  const clustered = groups.length - (alone.length > 0 ? 1 : 0);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    snapshotId: graph.snapshotId,
    origin: 'fallback',
    fallbackReason: reason,
    summary:
      `Grouped without AI: ${count(clustered, 'group')} of changes joined by a code edge or a shared file` +
      (alone.length > 0 ? `, and ${count(alone.length, 'node')} in ${UNGROUPED_TITLE}.` : '.'),
    groups,
    groupOrder: groups.map((g) => g.id),
    edgeVerdicts: [],
    inferredRelationships: [],
  };
}

/** A group for one cluster, named after its most called node, or its file when it has no edges. */
function group(id: string, nodes: ChangeNode[], graph: ChangeGraph): ReviewGroup {
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.codeEdges.filter((e) => ids.has(e.to));
  const incoming = (n: ChangeNode) => edges.filter((e) => e.to === n.id).length;
  // The first node with the most incoming edges: the callee the others propagate from (D1).
  const anchor = nodes.reduce((best, n) => (incoming(n) > incoming(best) ? n : best));
  const paths = [...new Set(nodes.map((n) => n.path))];
  return {
    id,
    title:
      edges.length === 0 ? `Changes in ${paths[0]}` : `${anchor.displayName} and related changes`,
    description:
      `${count(nodes.length, 'node')} in ${list(paths)}` +
      (edges.length === 0 ? '.' : `, joined by ${count(edges.length, 'code edge')}.`),
    nodeIds: nodes.map((n) => n.id),
    referenceNodeIds: [],
    childGroupIds: [],
  };
}
