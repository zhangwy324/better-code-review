// Before/after entity matching (#15, design reference §19.4 Q3). Phased, as sem does (a design
// reference only, docs/research/existing-tools.md):
//   1. same name: same file, kind, name and container
//   2. same content hash: a rename or a move, possibly to another file
//   3. same signature: a rename with edits, in the same file
//   4. fuzzy similarity: a rename with edits, in the same file
// Entities are matched outermost first, so a method of a renamed class still matches by name:
// "same container" means the two parents were matched to each other.
import type { Entity } from './entities.ts';

/** The entities of one file change. `file` identifies the change; old and new share it. */
export interface FileEntities {
  file: number;
  old: Entity[];
  new: Entity[];
}

export interface EntityPair {
  old: { file: number; entity: Entity } | null;
  new: { file: number; entity: Entity } | null;
  /** Matched, but the parents were not matched to each other: it moved to another container. */
  reparented: boolean;
}

/** Below this, two entities are too different to call one a rename of the other. */
const FUZZY_THRESHOLD = 0.8;
/** A shared signature only counts as a rename when the code is at least this similar too. */
const SIGNATURE_THRESHOLD = 0.5;
/**
 * Entities smaller than this many tokens only match by name: `function f(): void {}` and
 * `function g(): void {}` hash the same, but that says nothing about one being the other.
 */
const MIN_TOKENS = 16;

interface Side {
  file: number;
  entity: Entity;
}

export function matchEntities(files: FileEntities[]): EntityPair[] {
  const olds: Side[] = files.flatMap((f) => f.old.map((entity) => ({ file: f.file, entity })));
  const news: Side[] = files.flatMap((f) => f.new.map((entity) => ({ file: f.file, entity })));
  const matched = new Map<Entity, Entity>();
  const pairs: EntityPair[] = [];
  const pair = (o: Side, n: Side) => {
    matched.set(o.entity, n.entity);
    matched.set(n.entity, o.entity);
    pairs.push({ old: o, new: n, reparented: !sameParent(o.entity, n.entity) });
  };
  const sameParent = (o: Entity, n: Entity) =>
    o.parent === null ? n.parent === null : n.parent !== null && matched.get(o.parent) === n.parent;
  const sameScope = (o: Side, n: Side) =>
    o.file === n.file && o.entity.kind === n.entity.kind && sameParent(o.entity, n.entity);

  const maxDepth = Math.max(0, ...[...olds, ...news].map((s) => s.entity.depth));
  for (let depth = 0; depth <= maxDepth; depth++) {
    const unmatched = (sides: Side[]) =>
      sides.filter((s) => s.entity.depth === depth && !matched.has(s.entity));
    const greedy = (accept: (o: Side, n: Side) => boolean, minTokens = MIN_TOKENS) => {
      const big = (s: Side) => s.entity.tokens.length >= minTokens;
      const candidates = unmatched(news).filter(big);
      for (const o of unmatched(olds).filter(big)) {
        const n = candidates.find((c) => !matched.has(c.entity) && accept(o, c));
        if (n) pair(o, n);
      }
    };

    greedy((o, n) => sameScope(o, n) && o.entity.name === n.entity.name, 0);
    // Prefer a candidate in the same scope, so a duplicated body pairs with its own copy.
    greedy((o, n) => sameScope(o, n) && o.entity.contentHash === n.entity.contentHash);
    greedy(
      (o, n) => o.entity.kind === n.entity.kind && o.entity.contentHash === n.entity.contentHash,
    );
    greedy(
      (o, n) =>
        sameScope(o, n) &&
        o.entity.signature !== null &&
        o.entity.signature === n.entity.signature &&
        similarity(o.entity.tokens, n.entity.tokens) >= SIGNATURE_THRESHOLD,
    );

    // Fuzzy: best-scoring pairs first, ties in source order.
    const scored: { o: Side; n: Side; score: number }[] = [];
    for (const o of unmatched(olds)) {
      for (const n of unmatched(news)) {
        if (
          !sameScope(o, n) ||
          Math.min(o.entity.tokens.length, n.entity.tokens.length) < MIN_TOKENS
        ) {
          continue;
        }
        const score = similarity(o.entity.tokens, n.entity.tokens);
        if (score >= FUZZY_THRESHOLD) scored.push({ o, n, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { o, n } of scored) {
      if (!matched.has(o.entity) && !matched.has(n.entity)) pair(o, n);
    }
  }

  for (const o of olds)
    if (!matched.has(o.entity)) pairs.push({ old: o, new: null, reparented: false });
  for (const n of news)
    if (!matched.has(n.entity)) pairs.push({ old: null, new: n, reparented: false });
  return pairs;
}

/** Dice coefficient of two token multisets: 1 when equal, 0 when disjoint. */
export function similarity(a: string[], b: string[]): number {
  if (a.length + b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}
