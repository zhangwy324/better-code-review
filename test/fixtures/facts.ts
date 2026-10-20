// Reads a generated ChangeSet and ChangeGraph back into the ExpectedFacts notation (README.md),
// and checks what holds for every fixture: exact diffs, source mapping and capability reporting.
import { expect } from 'vitest';
import { hunkLines } from '../../src/git/patch.ts';
import type { ChangeGraph, ChangeSet, DiffHunk } from '../../src/schemas/index.ts';
import type { ExpectedFacts, Files } from './fixture.ts';

/**
 * The graph's facts in the ExpectedFacts notation, sorted. With `provenance`, each edge ends
 * with it, e.g. `checkoutSummary calls formatPrice (both) verified`.
 */
export function facts(
  changeSet: ChangeSet,
  graph: ChangeGraph,
  { provenance = false } = {},
): Required<ExpectedFacts> {
  // A display name shared by several nodes gets its path, so the facts say which one is meant.
  const counts = new Map<string, number>();
  for (const n of graph.nodes) counts.set(n.displayName, (counts.get(n.displayName) ?? 0) + 1);
  const label = new Map(
    graph.nodes.map((n) => [
      n.id,
      counts.get(n.displayName)! > 1 ? `${n.displayName} [${n.path}]` : n.displayName,
    ]),
  );
  const byEntity = new Map(graph.nodes.map((n) => [n.entityId, label.get(n.id)!]));
  const omitted = new Map(changeSet.files.map((f) => [f.newPath ?? f.oldPath, f.contentOmitted]));
  return {
    files: graph.files
      .map((f) => {
        const reasons = new Set([f.skipped, omitted.get(f.path)]);
        return [f.path, f.capabilityTier, f.test === null ? null : 'test', ...reasons]
          .filter(Boolean)
          .join(' ');
      })
      .sort(),
    nodes: graph.nodes.map((n) => `${n.kind} ${label.get(n.id)}`).sort(),
    edges: graph.codeEdges
      .map((e) => {
        const from = e.granularity === 'entity' ? label.get(e.from) : e.fromPath;
        const edge = `${from} ${e.relation} ${label.get(e.to)} (${e.sides})`;
        return provenance ? `${edge} ${e.provenance}` : edge;
      })
      .sort(),
    caps: graph.caps
      .map((c) => `${byEntity.get(c.entityId)} ${c.relation} ${c.shown}/${c.total}`)
      .sort(),
  };
}

/**
 * Exact diff preservation: each side's content is the fixture's file, byte for byte, and the
 * hunks applied to the old content give the new content.
 */
export function expectExactDiff(changeSet: ChangeSet, base: Files, head: Files): void {
  const text = (spec: Files[string] | undefined) =>
    typeof spec === 'string' ? spec : spec && !Buffer.isBuffer(spec) ? spec.content : null;
  for (const file of changeSet.files) {
    if (file.contentOmitted !== null) continue;
    const path = file.newPath ?? file.oldPath!;
    if (file.oldPath !== null) expect(file.oldContent, path).toBe(text(base[file.oldPath]));
    if (file.newPath !== null) {
      const spec = file.newPath in head ? head[file.newPath] : base[file.newPath];
      expect(file.newContent, path).toBe(text(spec));
    }
    expect(applyHunks(file.oldContent ?? '', file.hunks), path).toBe(file.newContent ?? '');
  }
}

/** `old` with `hunks` applied. Every fixture file ends in a newline. */
function applyHunks(old: string, hunks: DiffHunk[]): string {
  const from = old === '' ? [] : old.slice(0, -1).split('\n');
  const to: string[] = [];
  let next = 0;
  for (const hunk of hunks) {
    // A hunk with no old lines starts after line oldStart, not at it.
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    to.push(...from.slice(next, start));
    next = start;
    for (const line of hunkLines(hunk)) {
      if (line.kind !== 'added') expect(line.text).toBe(from[next++]);
      if (line.kind !== 'removed') to.push(line.text);
    }
  }
  to.push(...from.slice(next));
  return to.length === 0 ? '' : `${to.join('\n')}\n`;
}

/**
 * Source mapping: each symbol node's range holds its name, and each of its hunks changes a line
 * inside its range on one side.
 */
export function expectSourceMapping(changeSet: ChangeSet, graph: ChangeGraph): void {
  const files = new Map(changeSet.files.map((f) => [f.newPath ?? f.oldPath!, f]));
  const hunks = new Map(changeSet.files.flatMap((f) => f.hunks.map((h) => [h.id, h])));
  for (const node of graph.nodes.filter((n) => n.kind === 'symbol')) {
    const file = files.get(node.path)!;
    const name = node.displayName.split('.').at(-1)!;
    // The name is the new side's; a renamed entity has its old name on the old side.
    const [range, content] =
      node.newRange === null ? [node.oldRange!, file.oldContent] : [node.newRange, file.newContent];
    if (content !== null) {
      const text = content
        .split('\n')
        .slice(range.startLine - 1, range.endLine)
        .join('\n');
      expect(text, node.displayName).toContain(name);
    }
    for (const id of node.hunkIds) {
      const changed = changedLines(hunks.get(id)!);
      const inside = (range: typeof node.oldRange, lines: number[]) =>
        range !== null && lines.some((l) => l >= range.startLine && l <= range.endLine);
      expect(
        inside(node.oldRange, changed.old) || inside(node.newRange, changed.new),
        `${node.displayName} ${id}`,
      ).toBe(true);
    }
  }
}

/** The line numbers a hunk removes (old side) and adds (new side). */
function changedLines(hunk: DiffHunk): { old: number[]; new: number[] } {
  const lines = hunkLines(hunk);
  return {
    old: lines.flatMap((l) => (l.kind === 'removed' ? [l.oldLine!] : [])),
    new: lines.flatMap((l) => (l.kind === 'added' ? [l.newLine!] : [])),
  };
}
