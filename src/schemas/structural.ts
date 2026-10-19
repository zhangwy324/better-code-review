// StructuralChangeSet (§9.3): which code entities the hunks touch. Produced by the structural
// analyzer (#15). In-memory between stages; the graph carries what the artifact needs.
//
// Invariants:
// - Every hunk is attributed to at least one entity or listed in `unattributedHunkIds` (#15).
// - In a supported language, hunks outside any entity belong to the file's `module` entity (D2).
// - Entities with the same path, container, name and kind form one overload set (#42).
import { z } from 'zod';
import { EntityId, HunkId, RepoPath, SnapshotId, SourceRange } from './common.ts';

export const STRUCTURAL_SCHEMA_VERSION = 1;

/** `supported`: our tested queries. `community`: upstream tags.scm. `text-only`: no grammar. */
export const StructuralTier = z.enum(['supported', 'community', 'text-only']);

/** One changed file as the analyzers saw it. */
export const AnalyzedFile = z.strictObject({
  /** `newPath ?? oldPath` of the file change. */
  path: RepoPath,
  /** Grammar name, e.g. `typescript`, `tsx`, `python`. Null when none matched. */
  language: z.string().min(1).nullable(),
  tier: StructuralTier,
  /** Why the file was treated as a test or test-support file (D2), or null if it was not. */
  test: z.enum(['path-convention', 'declared-test-root', 'content']).nullable(),
  /** Why structural analysis was skipped. Skipped files get one file node (D2). */
  skipped: z.enum(['binary', 'too-large', 'generated', 'parse-error']).nullable(),
});

export const EntityKind = z.enum([
  'function',
  'method',
  'constructor',
  'class',
  'interface',
  'enum',
  /** A TS `namespace` or `module` block; it is the container of what it declares. */
  'namespace',
  'type',
  /** Top-level code outside any other entity: imports, top-level statements (D2). */
  'module',
]);

export const ChangedEntity = z.strictObject({
  id: EntityId,
  kind: EntityKind,
  /** Null for `module` entities. */
  name: z.string().min(1).nullable(),
  /** Qualified name of the enclosing class or namespace, e.g. `Fmt`, or null at top level. */
  container: z.string().min(1).nullable(),
  /** The file on the new side, or the old side for deleted entities. */
  path: RepoPath,
  /** The old-side path when it differs from `path` (rename or move). */
  oldPath: RepoPath.nullable(),
  change: z.enum(['added', 'modified', 'deleted', 'renamed', 'moved']),
  /** Extent of the entity on each side, including leading doc comments (#42). */
  oldRange: SourceRange.nullable(),
  newRange: SourceRange.nullable(),
  hunkIds: z.array(HunkId).min(1),
});

export const StructuralChangeSet = z.strictObject({
  schemaVersion: z.literal(STRUCTURAL_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  files: z.array(AnalyzedFile),
  entities: z.array(ChangedEntity),
  unattributedHunkIds: z.array(HunkId),
});

export type AnalyzedFile = z.infer<typeof AnalyzedFile>;
export type EntityKind = z.infer<typeof EntityKind>;
export type ChangedEntity = z.infer<typeof ChangedEntity>;
export type StructuralChangeSet = z.infer<typeof StructuralChangeSet>;
