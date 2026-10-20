// The graph invariant validator (#19, design reference §9.8, §13.2): checks a ChangeGraph against
// the ChangeSet it was built from, for the rules the schema cannot check on one document alone
// (src/schemas/README.md, "What is checked where"). `buildGraph()` runs it on every graph it
// returns, so a builder bug fails the run instead of reaching the artifact.
//
// The rules, numbered as the spec's "Invariants":
// - Every ID is unique within its list: hunks, nodes, edges, evidence (1).
// - Every hunk is on at least one node (2, 7), and `uncoveredHunkIds` is empty: unsupported files
//   get file nodes, so a hunk with no node is a builder bug (MVP spec M1: "100% of hunks have a
//   home node").
// - Every ID the graph references exists: hunks in the ChangeSet; nodes, test files, evidence and
//   entities in the graph (3).
// - Every edge's records match its relation and ends, and its `sides` are theirs; a `verified`
//   edge cites a confirmed `lsp` record; every record is cited by an edge and points at a real
//   line of a changed file on its side (4).
//
// Coverage is counted from the ChangeSet's hunks, not from nodes, so a node holding no changed
// hunk (a context node, design reference §9.5; none exist in v0.1, D12) cannot inflate it.
//
// Violations come back as a list of messages, so a caller can show all of them at once (the plan
// validator, #23, returns its own to the agent in the repair loop). `InvariantError` carries them.
import type { ChangeSet } from '../schemas/changeset.ts';
import type { ChangeGraph, ChangeNode } from '../schemas/graph.ts';
import type { EvidenceRecord } from '../schemas/semantic.ts';

export class InvariantError extends Error {
  readonly violations: string[];

  constructor(what: string, violations: string[]) {
    super(`${what} breaks ${violations.length} invariant(s):\n- ${violations.join('\n- ')}`);
    this.name = 'InvariantError';
    this.violations = violations;
  }
}

/** Throws `InvariantError` listing every violation, if there are any. */
export function assertValidGraph(graph: ChangeGraph, changeSet: ChangeSet): void {
  const violations = graphViolations(graph, changeSet);
  if (violations.length > 0) throw new InvariantError('graph', violations);
}

/** `N/N hunks mapped` (§13.2): changed hunks on at least one node, out of all changed hunks. */
export function hunkCoverage(
  graph: ChangeGraph,
  changeSet: ChangeSet,
): { mapped: number; total: number } {
  const onNodes = new Set(graph.nodes.flatMap((n) => n.hunkIds));
  const hunks = changeSet.files.flatMap((f) => f.hunks);
  return { mapped: hunks.filter((h) => onNodes.has(h.id)).length, total: hunks.length };
}

/** Every invariant violation of `graph` against its ChangeSet, or an empty list. */
export function graphViolations(graph: ChangeGraph, changeSet: ChangeSet): string[] {
  const out: string[] = [];
  if (graph.snapshotId !== changeSet.snapshotId) {
    out.push(`graph is for snapshot ${graph.snapshotId}, not ${changeSet.snapshotId}`);
  }

  const hunkIds = changeSet.files.flatMap((f) => f.hunks.map((h) => h.id));
  out.push(...duplicates('hunk', hunkIds));
  out.push(
    ...duplicates(
      'node',
      graph.nodes.map((n) => n.id),
    ),
  );
  out.push(
    ...duplicates(
      'edge',
      graph.codeEdges.map((e) => e.id),
    ),
  );
  out.push(
    ...duplicates(
      'evidence record',
      graph.evidence.map((r) => r.id),
    ),
  );

  // Coverage (2, 7).
  const hunks = new Set(hunkIds);
  const onNodes = new Set(graph.nodes.flatMap((n) => n.hunkIds));
  for (const id of hunks) if (!onNodes.has(id)) out.push(`hunk ${id} is on no node`);
  for (const id of graph.uncoveredHunkIds) {
    out.push(`uncoveredHunkIds lists hunk ${id}; every hunk must be on a node`);
  }
  for (const node of graph.nodes) {
    for (const id of node.hunkIds) {
      if (!hunks.has(id)) out.push(`node ${node.id} cites hunk ${id}, which is not in the change`);
    }
  }

  // References (3) and evidence (4).
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeOfEntity = new Map<string, ChangeNode>();
  for (const n of graph.nodes) if (n.entityId !== null) nodeOfEntity.set(n.entityId, n);
  const records = new Map(graph.evidence.map((r) => [r.id, r]));
  const filePaths = new Set(graph.files.map((f) => f.path));
  const citedIds = new Set(graph.codeEdges.flatMap((e) => e.evidenceIds));

  for (const edge of graph.codeEdges) {
    const to = nodes.get(edge.to);
    if (to === undefined) out.push(`edge ${edge.id} points to node ${edge.to}, which is missing`);
    let from: ChangeNode | undefined;
    if (edge.granularity === 'entity') {
      from = nodes.get(edge.from);
      if (from === undefined) {
        out.push(`edge ${edge.id} comes from node ${edge.from}, which is missing`);
      }
    } else if (!filePaths.has(edge.fromPath)) {
      out.push(`edge ${edge.id} comes from ${edge.fromPath}, which is not a changed file`);
    }

    const cited: EvidenceRecord[] = [];
    for (const id of edge.evidenceIds) {
      const record = records.get(id);
      if (record === undefined) out.push(`edge ${edge.id} cites evidence ${id}, which is missing`);
      else cited.push(record);
    }
    for (const r of cited) {
      const source = nodeOfEntity.get(r.sourceEntityId);
      const matches =
        r.relation === edge.relation &&
        (to === undefined || r.targetEntityId === to.entityId) &&
        (edge.granularity === 'entity'
          ? from === undefined || r.sourceEntityId === from.entityId
          : source === undefined || source.path === edge.fromPath);
      if (!matches) out.push(`edge ${edge.id} cites evidence ${r.id}, which is about another edge`);
    }
    if (
      edge.provenance === 'verified' &&
      !cited.some((r) => r.method === 'lsp' && r.outcome === 'confirmed')
    ) {
      out.push(`edge ${edge.id} is verified but cites no confirmed lsp evidence`);
    }
    const sides = new Set(cited.map((r) => r.location.side));
    const citedSides = sides.size > 1 ? 'both' : [...sides][0];
    if (citedSides !== undefined && citedSides !== edge.sides) {
      out.push(
        `edge ${edge.id} is on the ${edge.sides} side(s), but its evidence is on ${citedSides}`,
      );
    }
  }

  for (const r of graph.evidence) {
    if (!citedIds.has(r.id)) out.push(`evidence ${r.id} is cited by no edge`);
    for (const entity of [r.sourceEntityId, r.targetEntityId]) {
      if (!nodeOfEntity.has(entity)) {
        out.push(`evidence ${r.id} cites entity ${entity}, which has no node`);
      }
    }
    const problem = locationProblem(r, changeSet);
    if (problem !== null) out.push(`evidence ${r.id} is ${problem}`);
  }
  for (const cap of graph.caps) {
    if (!nodeOfEntity.has(cap.entityId)) {
      out.push(`a fan-out cap names entity ${cap.entityId}, which has no node`);
    }
  }
  return out;
}

/** One message per ID that occurs more than once. */
function duplicates(what: string, ids: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) (seen.has(id) ? repeated : seen).add(id);
  return [...repeated].map((id) => `${what} ID ${id} is not unique`);
}

/** Why a record's location is not in the snapshot, or null when it is. */
function locationProblem(record: EvidenceRecord, changeSet: ChangeSet): string | null {
  const { path, side, range } = record.location;
  const file = changeSet.files.find((f) => (side === 'old' ? f.oldPath : f.newPath) === path);
  if (file === undefined) return `at ${path} (${side}), which is not a changed file on that side`;
  const content = side === 'old' ? file.oldContent : file.newContent;
  if (content === null) return null; // Omitted content (D7): nothing to check the line against.
  const lines = content.split('\n');
  const lineCount = lines.length - (lines.at(-1) === '' ? 1 : 0);
  if (range.endLine > lineCount) {
    return `at ${path}:${range.endLine} (${side}), past the file's ${lineCount} lines`;
  }
  return null;
}
