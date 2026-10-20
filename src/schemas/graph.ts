// ChangeGraph (§9.5): the deterministic graph, written as graph.json. Produced by the graph
// builder (#18) and checked by the invariant validator (#19). The agent never edits it (D6).
//
// Invariants (spec "Invariants"):
// - Every hunk in the ChangeSet is on at least one node, so `uncoveredHunkIds` is empty (2, 7).
// - Every ID referenced here exists here or in the ChangeSet (3).
// - Every `verified` edge cites at least one `lsp` evidence record with outcome `confirmed` (4).
// - Only code edges live here; inferred and propagation links live in the plan (D6).
// - All nodes are changed code. Unchanged callers are not represented (D12).
import { z } from 'zod';
import {
  EdgeId,
  EntityId,
  EvidenceId,
  HunkId,
  NodeId,
  RepoPath,
  SnapshotId,
  SourceRange,
} from './common.ts';
import { AnalyzedFile, EntityKind } from './structural.ts';
import { CodeRelation, EvidenceRecord, FanOutCap, LanguageCapability } from './semantic.ts';

export const GRAPH_SCHEMA_VERSION = 1;

/**
 * D2 node granularity: `symbol` for the innermost recognised entity, `module` for code outside
 * any entity in a supported language, `file` for everything else.
 */
export const ChangeNode = z.strictObject({
  id: NodeId,
  kind: z.enum(['symbol', 'module', 'file']),
  /** The structural entity behind a `symbol` or `module` node; null for `file` nodes. */
  entityId: EntityId.nullable(),
  /** Null for `module` and `file` nodes. */
  entityKind: EntityKind.nullable(),
  displayName: z.string().min(1),
  path: RepoPath,
  /** The old-side path when it differs from `path`. */
  oldPath: RepoPath.nullable(),
  oldRange: SourceRange.nullable(),
  newRange: SourceRange.nullable(),
  /** Empty only for file changes without hunks (binary, mode-only, pure rename). */
  hunkIds: z.array(HunkId),
});

const edgeFields = {
  /** The changed entity being called, referenced or implemented (callee → callers, D1). */
  to: NodeId,
  relation: CodeRelation,
  /** `verified` needs LSP evidence; everything else is `possible` (D6). */
  provenance: z.enum(['verified', 'possible']),
  evidenceIds: z.array(EvidenceId).min(1),
};

export const CodeEdge = z.discriminatedUnion('granularity', [
  z.strictObject({ id: EdgeId, granularity: z.literal('entity'), from: NodeId, ...edgeFields }),
  /** One edge per (test file, changed entity) (D2). */
  z.strictObject({
    id: EdgeId,
    granularity: z.literal('test-file'),
    fromPath: RepoPath,
    ...edgeFields,
  }),
]);

/**
 * Which analysis a file got (design reference §10.8), weakest first: `git-only` with no grammar
 * or no structural result (a file node), `structural` with entities but no language server
 * answering for its language (edges `possible` at best), `semantic` when one answered, so its
 * edges can be `verified`.
 */
export const CapabilityTier = z.enum(['git-only', 'structural', 'semantic']);

/** A changed file as the analyzers saw it, plus the capability tier it got. */
export const GraphFile = AnalyzedFile.extend({ capabilityTier: CapabilityTier });

export const ChangeGraph = z.strictObject({
  schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  /** The weakest and strongest `capabilityTier` of `files`; both `git-only` when there are none. */
  weakestTier: CapabilityTier,
  strongestTier: CapabilityTier,
  /** Every changed file, with its language, tiers and test classification (D2, D11). */
  files: z.array(GraphFile),
  /** Per-language semantic capability (D11). */
  languages: z.array(LanguageCapability),
  nodes: z.array(ChangeNode),
  codeEdges: z.array(CodeEdge),
  /** The evidence records cited by `codeEdges`, and no others. */
  evidence: z.array(EvidenceRecord),
  caps: z.array(FanOutCap),
  /**
   * Hunks with no node. Always empty: unsupported files get file nodes, and the invariant validator
   * rejects a graph that lists any.
   */
  uncoveredHunkIds: z.array(HunkId),
});

export type CapabilityTier = z.infer<typeof CapabilityTier>;
export type GraphFile = z.infer<typeof GraphFile>;
export type ChangeNode = z.infer<typeof ChangeNode>;
export type CodeEdge = z.infer<typeof CodeEdge>;
export type ChangeGraph = z.infer<typeof ChangeGraph>;
