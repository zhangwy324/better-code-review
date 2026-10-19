// Stable ID scheme. See "IDs" in README.md for what each kind of ID is derived from.
import { createHash } from 'node:crypto';

export type IdPrefix = 'h' | 'ent' | 'n' | 'e' | 'ev';

/**
 * Derives a deterministic ID from the parts that identify a record within its snapshot, so the
 * same snapshot always yields the same IDs. Parts are JSON-encoded before hashing, so
 * `['a', 'b']` and `['a,b']` cannot collide.
 */
export function stableId(prefix: IdPrefix, parts: readonly (string | number | null)[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${prefix}_${digest.slice(0, 16)}`;
}
