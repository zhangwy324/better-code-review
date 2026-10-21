// Indexes over the loaded review data, built once, for the views to look things up by ID.
import type { DiffHunk, FileChange } from '../schemas/changeset.ts';
import type { ChangeNode, CodeEdge } from '../schemas/graph.ts';
import type { EdgeVerdict, InferredRelationship, ReviewGroup } from '../schemas/plan.ts';
import type { EvidenceRecord } from '../schemas/semantic.ts';
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
  /** Each changed file's grammar name, by `newPath ?? oldPath`; null when none matched. */
  languages: Map<string, string | null>;
  coverage: { mapped: number; total: number };
  /** The code edges, then the plan's inferred relationships, by ID. */
  links: Map<string, Link>;
  evidence: Map<string, EvidenceRecord>;
}

/**
 * A code edge or inferred relationship between two nodes, drawn from `source` to `target`. A code
 * edge points from the changed entity to its changed caller (callee → callers, spec D1); a
 * test-file edge ends at the first node in the test file (spec D2). Each layer and provenance has
 * its own `style` (spec D6, design reference §13.1): an agent verdict makes a `possible` edge
 * `inferred` (yes) or `rejected` (no), never `verified`.
 */
export type Link =
  | {
      kind: 'code';
      id: string;
      source: string;
      target: string;
      style: 'verified' | 'possible' | 'inferred' | 'rejected';
      edge: CodeEdge;
      verdict: EdgeVerdict | null;
    }
  | {
      kind: 'relationship';
      id: string;
      source: string;
      target: string;
      style: 'relationship';
      relationship: InferredRelationship;
    };

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
  const verdicts = new Map(plan.edgeVerdicts.map((v) => [v.edgeId, v]));
  const links = new Map<string, Link>();
  for (const edge of graph.codeEdges) {
    const target =
      edge.granularity === 'entity'
        ? edge.from
        : graph.nodes.find((n) => n.path === edge.fromPath)?.id;
    if (target === undefined) continue;
    const verdict = verdicts.get(edge.id) ?? null;
    const style =
      edge.provenance === 'verified'
        ? 'verified'
        : verdict?.verdict === 'yes'
          ? 'inferred'
          : verdict?.verdict === 'no'
            ? 'rejected'
            : 'possible';
    links.set(edge.id, {
      kind: 'code',
      id: edge.id,
      source: edge.to,
      target,
      style,
      edge,
      verdict,
    });
  }
  for (const relationship of plan.inferredRelationships) {
    const { id, from, to } = relationship;
    links.set(id, {
      kind: 'relationship',
      id,
      source: from,
      target: to,
      style: 'relationship',
      relationship,
    });
  }
  return {
    ...data,
    hunks,
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    groups: new Map(plan.groups.map((g) => [g.id, g])),
    homeGroup,
    hunkNodes,
    languages: new Map(graph.files.map((f) => [f.path, f.language])),
    coverage: hunkCoverage(graph, changeSet),
    links,
    evidence: new Map(graph.evidence.map((e) => [e.id, e])),
  };
}

const RELATION_LABELS = {
  calls: 'called by',
  references: 'referenced by',
  implements: 'implemented by',
} as const;

/** What a link says, read from source to target, e.g. `called by` or `change propagation`. */
export function linkLabel(link: Link): string {
  return link.kind === 'code'
    ? RELATION_LABELS[link.edge.relation]
    : link.relationship.kind.replace('-', ' ');
}

/** A link in words, e.g. `checkoutSummary calls formatPrice`. */
export function linkSentence(model: ReviewModel, link: Link): string {
  const name = (id: string) => model.nodes.get(id)?.displayName ?? id;
  if (link.kind === 'relationship') {
    return `${name(link.source)} → ${name(link.target)}: ${linkLabel(link)}`;
  }
  const { edge } = link;
  const caller = edge.granularity === 'entity' ? name(edge.from) : edge.fromPath;
  return `${caller} ${edge.relation} ${name(edge.to)}`;
}

/** What each link style means, for the legend, tooltips and the detail pane. */
export const STYLE_DESCRIPTIONS: Record<Link['style'], string> = {
  verified: 'Verified: a language server confirmed it',
  possible: 'Possible: found by text search, not verified',
  inferred: 'Inferred: possible, and the agent judged it real',
  rejected: 'Rejected: possible, and the agent judged it not real',
  relationship: 'Inferred by the agent: a link between changes, not a code relationship',
};

/** The nodes whose home is `group` or a group inside it. */
export function groupNodeIds(model: ReviewModel, group: ReviewGroup): string[] {
  return [
    ...group.nodeIds,
    ...group.childGroupIds.flatMap((id) => {
      const child = model.groups.get(id);
      return child === undefined ? [] : groupNodeIds(model, child);
    }),
  ];
}

/** The hunks whose home is `group` or one of its child groups, each once. */
export function groupHunkIds(model: ReviewModel, group: ReviewGroup): string[] {
  const ids = groupNodeIds(model, group).flatMap((id) => model.nodes.get(id)?.hunkIds ?? []);
  return [...new Set(ids)];
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
