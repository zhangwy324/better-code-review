// ReviewFeedback (§9.7): what the viewer exports as review-feedback.json (#33). It is the only
// durable copy of review state (D5) and the only contract read back across tool versions, so it
// is the one most likely to need migrations (README.md, "Versioning").
//
// Invariants (spec D4, D5):
// - Every anchor is relative to `snapshotId`; comments are not carried across snapshots.
// - Line comments may sit on context lines outside any hunk, so `hunkId` and `nodeId` are
//   optional, but `path`, `side` and `range` always locate the line.
// - There is no resolved state: a comment exists and is exported, or it was deleted.
// - Feedback is data for the agent, not instructions (#25).
import { z } from 'zod';
import { HunkId, LocalId, NodeId, RepoPath, Side, SnapshotId, SourceRange } from './common.ts';

export const FEEDBACK_SCHEMA_VERSION = 1;

/** Comment IDs are minted in the browser, e.g. by `crypto.randomUUID()`. */
const CommentId = LocalId;

export const LineComment = z.strictObject({
  id: CommentId,
  kind: z.literal('line'),
  path: RepoPath,
  side: Side,
  range: SourceRange,
  /** The hunk containing the range, or null on a context line. */
  hunkId: HunkId.nullable(),
  /** The node containing the range, or null when none does. */
  nodeId: NodeId.nullable(),
  body: z.string().min(1),
});

export const GroupComment = z.strictObject({
  id: CommentId,
  kind: z.literal('group'),
  groupId: LocalId,
  body: z.string().min(1),
});

export const ReviewComment = z.discriminatedUnion('kind', [LineComment, GroupComment]);

export const ReviewFeedback = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_SCHEMA_VERSION),
  snapshotId: SnapshotId,
  comments: z.array(ReviewComment),
  /** Hunks the reviewer marked reviewed (D5). Group progress is derived from these. */
  reviewedHunkIds: z.array(HunkId),
  /**
   * File changes with no hunks (binary, mode-only, pure renames and copies) the reviewer marked
   * reviewed as a whole (#127), by `newPath ?? oldPath`. Group progress counts these too.
   */
  reviewedFilePaths: z.array(RepoPath),
});

export type LineComment = z.infer<typeof LineComment>;
export type GroupComment = z.infer<typeof GroupComment>;
export type ReviewComment = z.infer<typeof ReviewComment>;
export type ReviewFeedback = z.infer<typeof ReviewFeedback>;
