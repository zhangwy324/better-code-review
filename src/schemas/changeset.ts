// ChangeSet (§9.2): the authoritative Git data, written as changes.json. Produced by the Git
// extractor (#10, #11, #12, #13).
//
// Invariants (spec "Invariants", §9.8):
// - Every hunk ID is unique within the snapshot (1).
// - `patch` is byte-exact Git output; all code the artifact shows comes from this file (5).
// - Text files carry full old and new content (D7) unless `contentOmitted` says why not.
import { z } from 'zod';
import { GitObjectId, HunkId, RepoPath, SnapshotId } from './common.ts';
import { ReviewTarget } from './request.ts';

export const CHANGESET_SCHEMA_VERSION = 1;

export const DiffHunk = z.strictObject({
  id: HunkId,
  /** The four numbers of the `@@ -oldStart,oldLines +newStart,newLines @@` header, as Git wrote them. */
  oldStart: z.int().min(0),
  oldLines: z.int().min(0),
  newStart: z.int().min(0),
  newLines: z.int().min(0),
  /** The hunk exactly as Git printed it, from the `@@` line through its last line. */
  patch: z.string().regex(/^@@ /),
});

export const FileStatus = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
]);

const FileMode = z.string().regex(/^[0-7]{6}$/);

export const FileChange = z.strictObject({
  status: FileStatus,
  /** Null for added files. */
  oldPath: RepoPath.nullable(),
  /** Null for deleted files. */
  newPath: RepoPath.nullable(),
  oldMode: FileMode.nullable(),
  newMode: FileMode.nullable(),
  binary: z.boolean(),
  /** Null on the side where the file does not exist, or when `contentOmitted` is set. */
  oldContent: z.string().nullable(),
  newContent: z.string().nullable(),
  /** Why content was not captured: binary, or over the size cap (#13). */
  contentOmitted: z.enum(['binary', 'too-large']).nullable(),
  /** In diff order. Empty for binary, mode-only and pure-rename changes. */
  hunks: z.array(DiffHunk),
});

export const ChangeSet = z.strictObject({
  schemaVersion: z.literal(CHANGESET_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  /** The target as requested. */
  target: ReviewTarget,
  /** The resolved base commit. Null when the base is the empty tree (e.g. a root commit). */
  baseRevision: GitObjectId.nullable(),
  /** The resolved head commit. Null when the head is the working tree (`local`). */
  headRevision: GitObjectId.nullable(),
  /** Sorted by path (`newPath ?? oldPath`), as Git orders a diff. */
  files: z.array(FileChange),
});

export type DiffHunk = z.infer<typeof DiffHunk>;
export type FileChange = z.infer<typeof FileChange>;
export type ChangeSet = z.infer<typeof ChangeSet>;
