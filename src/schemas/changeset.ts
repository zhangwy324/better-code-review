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

/** A symlink: its blob is the target path, not file content. */
export const SYMLINK_MODE = '120000';
/** A submodule (gitlink): it names a commit in another repository, so there is no blob. */
export const GITLINK_MODE = '160000';

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
  /** Why content was not captured: binary, or either side over the size cap (1 MiB, #13). */
  contentOmitted: z.enum(['binary', 'too-large']).nullable(),
  /** In diff order. Empty for binary, mode-only and pure-rename changes. */
  hunks: z.array(DiffHunk),
});

/**
 * The pull request a `pr` target names, as GitHub reports it, for the planner (§8.6). Its text is
 * written by the PR author: untrusted input, never instructions (§14.2).
 */
export const PullRequestInfo = z.strictObject({
  url: z.string().min(1),
  title: z.string(),
  /** The PR body in Markdown; empty when it has none. */
  description: z.string(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
});

export const ChangeSet = z.strictObject({
  schemaVersion: z.literal(CHANGESET_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  /** The target as requested. */
  target: ReviewTarget,
  /**
   * The resolved base commit: HEAD for `local`, and for `pr` the merge base of the PR's base and
   * head commits. Null when the base is the empty tree (a root commit, or a `local` target on a
   * branch with no commits yet).
   */
  baseRevision: GitObjectId.nullable(),
  /** The resolved head commit. Null when the head is the working tree (`local`). */
  headRevision: GitObjectId.nullable(),
  /** Sorted by path (`newPath ?? oldPath`), as Git orders a diff. */
  files: z.array(FileChange),
  /**
   * `local` only: untracked, non-ignored files left out because `includeUntracked` was false,
   * in byte order. Listed so the artifact can say what it does not show. Empty otherwise.
   */
  excludedUntrackedPaths: z.array(RepoPath),
  /** `pr` only: the pull request's metadata. Null otherwise. */
  pullRequest: PullRequestInfo.nullable(),
});

export type DiffHunk = z.infer<typeof DiffHunk>;
export type FileChange = z.infer<typeof FileChange>;
export type PullRequestInfo = z.infer<typeof PullRequestInfo>;
export type ChangeSet = z.infer<typeof ChangeSet>;
