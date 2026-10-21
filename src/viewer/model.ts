// Indexes over the loaded review data, built once, for the views to look things up by ID.
import type { DiffHunk, FileChange } from '../schemas/changeset.ts';
import type { ChangeNode } from '../schemas/graph.ts';
import type { ReviewGroup } from '../schemas/plan.ts';
import { hunkCoverage } from '../graph/validate.ts';
import type { ReviewData } from './data.ts';

export interface ReviewModel extends ReviewData {
  hunks: Map<string, { hunk: DiffHunk; file: FileChange }>;
  nodes: Map<string, ChangeNode>;
  groups: Map<string, ReviewGroup>;
  /** Each node's home group (spec D2). */
  homeGroup: Map<string, ReviewGroup>;
  /** The nodes each hunk belongs to, in graph order. */
  hunkNodes: Map<string, ChangeNode[]>;
  coverage: { mapped: number; total: number };
}

export function buildModel(data: ReviewData): ReviewModel {
  const { changeSet, graph, plan } = data;
  const hunks = new Map(
    changeSet.files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, { hunk, file }] as const)),
  );
  const hunkNodes = new Map<string, ChangeNode[]>();
  for (const node of graph.nodes) {
    for (const id of node.hunkIds) hunkNodes.set(id, [...(hunkNodes.get(id) ?? []), node]);
  }
  const homeGroup = new Map(plan.groups.flatMap((g) => g.nodeIds.map((id) => [id, g] as const)));
  return {
    ...data,
    hunks,
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    groups: new Map(plan.groups.map((g) => [g.id, g])),
    homeGroup,
    hunkNodes,
    coverage: hunkCoverage(graph, changeSet),
  };
}

/** The hunks whose home is `group` or one of its child groups, each once. */
export function groupHunkIds(model: ReviewModel, group: ReviewGroup): string[] {
  const ids = new Set<string>();
  const visit = (g: ReviewGroup) => {
    for (const id of g.nodeIds) for (const h of model.nodes.get(id)?.hunkIds ?? []) ids.add(h);
    for (const id of g.childGroupIds) {
      const child = model.groups.get(id);
      if (child !== undefined) visit(child);
    }
  };
  visit(group);
  return [...ids];
}

/** What the review is of, for the header, e.g. `PR #123: Add currency` or `commit 1a2b3c4`. */
export function targetLabel({ changeSet }: ReviewData): string {
  const short = (id: string | null) => (id ?? 'empty tree').slice(0, 7);
  const { target, pullRequest } = changeSet;
  switch (target.kind) {
    case 'pr':
      return `PR #${target.number}${pullRequest === null ? '' : `: ${pullRequest.title}`}`;
    case 'commit':
      return `commit ${short(changeSet.headRevision)}`;
    case 'range':
      return `${short(changeSet.baseRevision)}..${short(changeSet.headRevision)}`;
    case 'local':
      return 'local changes';
  }
}

export function filePath(file: FileChange): string {
  return (file.newPath ?? file.oldPath)!;
}

/** Added and removed lines in a hunk's patch. */
export function lineCounts(hunk: DiffHunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.patch.split('\n').slice(1)) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}
