// ReviewRequest (§9.1): what the skill or CLI asks the pipeline to review. In-memory only, so it
// carries no schemaVersion.
import { z } from 'zod';

/** A revision as the user typed it (a SHA, branch, tag or other rev-parse expression). */
const Revision = z.string().min(1);

export const ReviewTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pr'), number: z.int().min(1) }),
  z.strictObject({
    kind: z.literal('commit'),
    commit: Revision,
    /** Which parent to diff against, 1-based as in `<commit>^<n>`. Defaults to 1. */
    parent: z.int().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('local'), includeUntracked: z.boolean() }),
  z.strictObject({
    kind: z.literal('range'),
    base: Revision,
    head: Revision,
    /** `direct` diffs base..head; `merge-base` diffs merge-base(base, head)..head. */
    mode: z.enum(['direct', 'merge-base']),
  }),
]);

export const ReviewRequest = z.strictObject({
  /** Absolute path of the repository root. */
  repositoryPath: z.string().min(1),
  target: ReviewTarget,
  /** Absolute path the artifacts are written to (D9). */
  outputDirectory: z.string().min(1),
  analysis: z.strictObject({
    /** Use installed language servers (D11). They are never installed or downloaded. */
    useLsp: z.boolean(),
    /** Allow servers that run project code while indexing, e.g. jdtls with Gradle (D11). */
    allowProjectCodeExecution: z.boolean(),
  }),
});

export type ReviewTarget = z.infer<typeof ReviewTarget>;
export type ReviewRequest = z.infer<typeof ReviewRequest>;
