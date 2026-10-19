// Building blocks shared by every contract. See README.md in this folder for conventions.
import { z } from 'zod';

/**
 * An ID minted by the pipeline: a kind prefix and 16 lowercase hex characters, e.g.
 * `h_3f2a9c0d41b7e6a5`. Use `stableId()` (ids.ts) to make one.
 */
export function generatedId<P extends string>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[0-9a-f]{16}$`))
    .describe(`Generated ID: "${prefix}_" + 16 hex characters`);
}

export const HunkId = generatedId('h');
export const EntityId = generatedId('ent');
export const NodeId = generatedId('n');
export const EdgeId = generatedId('e');
export const EvidenceId = generatedId('ev');

/** Snapshot IDs are full SHA-256 hex digests; #10/#11 define what is hashed. */
export const SnapshotId = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('SHA-256 hex digest identifying the exact before/after snapshot');

/**
 * IDs chosen by the agent or the fallback planner (groups, inferred relationships, comments):
 * short, lowercase, safe to put in a URL fragment or a DOM id.
 */
export const LocalId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .describe('Lowercase letters, digits, "-" and "_", starting with a letter or digit, max 64');

/** A full Git object name (SHA-1 or SHA-256). */
export const GitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Repository-relative path, `/`-separated, exactly as Git reports it. */
export const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
    message: 'must be repository-relative',
  })
  .describe('Repository-relative, "/"-separated path as Git reports it');

/** `old` is the base side of the diff, `new` the head side. */
export const Side = z.enum(['old', 'new']);

const Line = z.int().min(1);
const Column = z.int().min(1);

/**
 * A span of source text on one side of a diff. Lines are 1-based and `endLine` is inclusive.
 * Columns are optional, 1-based, counted in UTF-16 code units, and `endColumn` is exclusive.
 */
export const SourceRange = z
  .strictObject({
    startLine: Line,
    startColumn: Column.optional(),
    endLine: Line,
    endColumn: Column.optional(),
  })
  .refine((r) => r.endLine >= r.startLine, { message: 'endLine must be >= startLine' });

/** One line of one file on one side of the snapshot, e.g. a cited line or an evidence site. */
export const LineRef = z.strictObject({
  path: RepoPath,
  side: Side,
  line: Line,
});

/** A range of one file on one side of the snapshot. */
export const CodeLocation = z.strictObject({
  path: RepoPath,
  side: Side,
  range: SourceRange,
});

export type SourceRange = z.infer<typeof SourceRange>;
export type LineRef = z.infer<typeof LineRef>;
export type CodeLocation = z.infer<typeof CodeLocation>;
export type Side = z.infer<typeof Side>;
