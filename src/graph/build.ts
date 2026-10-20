// The graph builder (#18, design reference §8.5, §9.5): turns a ChangeSet and whatever analysis
// is available into the deterministic ChangeGraph written as graph.json.
//
// Nodes (MVP spec D2): one per changed entity, `module` for a file's top-level code and `symbol`
// for the rest. A file with no entity, or with hunks no entity holds, gets one `file` node for
// those hunks, so every hunk is on a node at every capability tier. All nodes are changed code;
// unchanged callers are not represented (D12).
//
// Code edges, between changed entities only, from SemanticEvidence. The records at one hit
// location are judged together: `lsp` `confirmed` makes the hit verified; otherwise any
// `rejected` record drops it; otherwise it is possible. Hits with the same relation, source and
// target form one edge (callee → callers: `to` is the target), which is `verified` when any of
// its hits is and cites the records of every hit it keeps. A source in a test file makes a
// `test-file` edge from that file instead (D2). Rejected hits make no edge and are not copied.
// The builder only reports code relationships; it never adds propagation or causal links (D6).
//
// Determinism: IDs come from `stableId()`, and every list follows the order of its inputs (files
// in ChangeSet order, entities and records in analyzer order), which are deterministic.
import type { ChangeSet, FileChange } from '../schemas/changeset.ts';
import {
  GRAPH_SCHEMA_VERSION,
  ChangeGraph,
  type CapabilityTier,
  type ChangeNode,
  type CodeEdge,
} from '../schemas/graph.ts';
import { stableId } from '../schemas/ids.ts';
import type { EvidenceRecord, SemanticEvidence } from '../schemas/semantic.ts';
import type { AnalyzedFile, ChangedEntity, StructuralChangeSet } from '../schemas/structural.ts';

export interface GraphInputs {
  /** From `analyzeStructure()`. Without it the graph is `git-only`: one file node per file. */
  structure?: StructuralChangeSet | null;
  /** From `analyzeSemantics()`; needs `structure`. Without it there are no code edges. */
  evidence?: SemanticEvidence | null;
}

export function buildGraph(changeSet: ChangeSet, inputs: GraphInputs = {}): ChangeGraph {
  const structure = inputs.structure ?? null;
  const evidence = inputs.evidence ?? null;
  if (evidence !== null && structure === null) {
    throw new Error('semantic evidence needs the structural change set it was derived from');
  }
  for (const doc of [structure, evidence]) {
    if (doc !== null && doc.snapshotId !== changeSet.snapshotId) {
      throw new Error(`analysis is for snapshot ${doc.snapshotId}, not ${changeSet.snapshotId}`);
    }
  }

  const fileOfHunk = new Map<string, FileChange>();
  for (const file of changeSet.files) for (const h of file.hunks) fileOfHunk.set(h.id, file);
  const entities = structure?.entities ?? [];

  const nodes: ChangeNode[] = [];
  const nodeOfEntity = new Map<string, ChangeNode>();
  for (const file of changeSet.files) {
    const own = entities.filter((e) => fileOfHunk.get(e.hunkIds[0]!) === file);
    const held = new Set(own.flatMap((e) => e.hunkIds));
    const loose = file.hunks.filter((h) => !held.has(h.id)).map((h) => h.id);
    if (own.length === 0 || loose.length > 0) nodes.push(fileNode(file, loose));
    for (const entity of own) {
      const node = entityNode(entity);
      nodes.push(node);
      nodeOfEntity.set(entity.id, node);
    }
  }

  const onNodes = new Set(nodes.flatMap((n) => n.hunkIds));
  const uncoveredHunkIds = changeSet.files
    .flatMap((f) => f.hunks)
    .filter((h) => !onNodes.has(h.id))
    .map((h) => h.id);

  const files = structure?.files ?? changeSet.files.map(unanalysedFile);
  const testFileOf = (entity: string): string | null => {
    const node = nodeOfEntity.get(entity);
    if (node === undefined) throw new Error(`evidence cites ${entity}, which is not changed`);
    const change = fileOfHunk.get(node.hunkIds[0]!)!;
    const path = change.newPath ?? change.oldPath!;
    const test = files.find((f) => f.path === path)?.test ?? null;
    return test === null ? null : path;
  };
  const { codeEdges, cited } = edges(evidence?.records ?? [], nodeOfEntity, testFileOf);

  return ChangeGraph.parse({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    snapshotId: changeSet.snapshotId,
    capabilityTier: tier(structure, evidence),
    files,
    languages: evidence?.languages ?? [],
    nodes,
    codeEdges,
    evidence: (evidence?.records ?? []).filter((r) => cited.has(r.id)),
    caps: evidence?.caps ?? [],
    uncoveredHunkIds,
  });
}

function entityNode(entity: ChangedEntity): ChangeNode {
  const kind = entity.kind === 'module' ? 'module' : 'symbol';
  return {
    id: stableId('n', [kind, entity.id]),
    kind,
    entityId: entity.id,
    entityKind: kind === 'module' ? null : entity.kind,
    displayName:
      entity.name === null
        ? entity.path
        : entity.container === null
          ? entity.name
          : `${entity.container}.${entity.name}`,
    path: entity.path,
    oldPath: entity.oldPath,
    oldRange: entity.oldRange,
    newRange: entity.newRange,
    hunkIds: entity.hunkIds,
  };
}

function fileNode(file: FileChange, hunkIds: string[]): ChangeNode {
  const path = file.newPath ?? file.oldPath!;
  return {
    id: stableId('n', ['file', path]),
    kind: 'file',
    entityId: null,
    entityKind: null,
    displayName: path,
    path,
    oldPath: file.oldPath !== null && file.oldPath !== path ? file.oldPath : null,
    oldRange: null,
    newRange: null,
    hunkIds,
  };
}

/** A file as the git-only tier sees it: no language, no structure, no test classification. */
function unanalysedFile(file: FileChange): AnalyzedFile {
  return {
    path: file.newPath ?? file.oldPath!,
    language: null,
    tier: 'text-only',
    test: null,
    skipped: null,
  };
}

function tier(
  structure: StructuralChangeSet | null,
  evidence: SemanticEvidence | null,
): CapabilityTier {
  if (structure === null) return 'git-only';
  const answered = evidence?.languages.some((l) => l.status === 'ok' || l.status === 'unhealthy');
  return answered ? 'semantic' : 'structural';
}

function edges(
  records: EvidenceRecord[],
  nodeOfEntity: Map<string, ChangeNode>,
  testFileOf: (entity: string) => string | null,
): { codeEdges: CodeEdge[]; cited: Set<string> } {
  // The records of one hit share everything their ID is derived from except the method.
  const hits = new Map<string, EvidenceRecord[]>();
  for (const r of records) {
    const { path, side, range } = r.location;
    const key = JSON.stringify([
      r.relation,
      r.sourceEntityId,
      r.targetEntityId,
      path,
      side,
      range.startLine,
      range.startColumn,
    ]);
    hits.set(key, [...(hits.get(key) ?? []), r]);
  }

  const byEdge = new Map<string, CodeEdge>();
  for (const hit of hits.values()) {
    const verified = hit.some((r) => r.method === 'lsp' && r.outcome === 'confirmed');
    if (!verified && hit.some((r) => r.outcome === 'rejected')) continue;
    const { relation, sourceEntityId, targetEntityId } = hit[0]!;
    const to = nodeOfEntity.get(targetEntityId)?.id;
    if (to === undefined) throw new Error(`evidence cites ${targetEntityId}, which is not changed`);
    const testFile = testFileOf(sourceEntityId);
    const from = testFile ?? nodeOfEntity.get(sourceEntityId)!.id;
    const id = stableId('e', [relation, from, to]);
    let edge = byEdge.get(id);
    if (edge === undefined) {
      const fields = { id, to, relation, provenance: 'possible' as const, evidenceIds: [] };
      edge =
        testFile === null
          ? { ...fields, granularity: 'entity', from }
          : { ...fields, granularity: 'test-file', fromPath: testFile };
      byEdge.set(id, edge);
    }
    if (verified) edge.provenance = 'verified';
    edge.evidenceIds.push(...hit.map((r) => r.id));
  }

  const codeEdges = [...byEdge.values()];
  return { codeEdges, cited: new Set(codeEdges.flatMap((e) => e.evidenceIds)) };
}
