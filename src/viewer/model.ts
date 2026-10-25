// Indexes over the loaded review data, built once, for the views to look things up by ID, and
// review progress, derived from the review items marked reviewed (spec D5): the hunks, and each
// file change with no hunks as a whole (#127).
import type { DiffHunk, FileChange } from '../schemas/changeset.ts';
import type { CapabilityTier, ChangeNode, CodeEdge } from '../schemas/graph.ts';
import {
  type EdgeVerdict,
  type InferredRelationship,
  type ReviewGroup,
  UNGROUPED_GROUP_ID,
} from '../schemas/plan.ts';
import type { EvidenceRecord, LanguageCapability } from '../schemas/semantic.ts';
import { hunkCoverage } from '../graph/validate.ts';
import { homeEveryNode } from '../planner/validate.ts';
import { count } from '../text/index.ts';
import type { ReviewData } from './data.ts';

export interface ReviewModel extends ReviewData {
  hunks: Map<string, { hunk: DiffHunk; file: FileChange }>;
  /**
   * The file changes with no hunks (binary, mode-only, pure renames and copies), by
   * `newPath ?? oldPath`, in the change set's order. Each is one review item (#127).
   */
  hunkless: Map<string, FileChange>;
  /** Every review item (`reviewItemIds()`), in the change set's order. */
  reviewItems: string[];
  nodes: Map<string, ChangeNode>;
  groups: Map<string, ReviewGroup>;
  /** Each node's home group (spec D2). */
  homeGroup: Map<string, ReviewGroup>;
  /** The nodes each hunk belongs to, in graph order. */
  hunkNodes: Map<string, ChangeNode[]>;
  /** Each changed file's grammar name, by `newPath ?? oldPath`; null when none matched. */
  languages: Map<string, string | null>;
  /** Each changed file's capability tier (design reference §10.8), by `newPath ?? oldPath`. */
  tiers: Map<string, CapabilityTier>;
  /** The files with syntax errors, which parsed partially (#93), by `newPath ?? oldPath`. */
  partialParses: Set<string>;
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

/**
 * The model of `data`. A node the plan gave no home goes into the `ungrouped` group, as the plan
 * validator would put it (spec D1, invariant 2), so even a plan it never checked hides no change.
 */
export function buildModel(data: ReviewData): ReviewModel {
  const { changeSet, graph } = data;
  const { plan } = homeEveryNode(data.plan, graph);
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
    plan,
    hunks,
    hunkless: new Map(
      changeSet.files.filter((f) => f.hunks.length === 0).map((f) => [filePath(f), f] as const),
    ),
    reviewItems: changeSet.files.flatMap(reviewItemIds),
    nodes: new Map(graph.nodes.map((n) => [n.id, n])),
    groups: new Map(plan.groups.map((g) => [g.id, g])),
    homeGroup,
    hunkNodes,
    languages: new Map(graph.files.map((f) => [f.path, f.language])),
    tiers: new Map(graph.files.map((f) => [f.path, f.capabilityTier])),
    partialParses: new Set(graph.files.filter((f) => f.partialParse).map((f) => f.path)),
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

const FILE_ITEM = 'file:';

/**
 * The review item of a file change with no hunks (#127), which is marked reviewed as a whole.
 * Hunk IDs start with `h_`, so the two kinds of item never clash.
 */
export const fileItemId = (path: string) => `${FILE_ITEM}${path}`;

/** Whether a review item is a file change with no hunks, not a hunk. */
export const isFileItem = (id: string) => id.startsWith(FILE_ITEM);

/** The file change a review item is in. */
export function itemFile(model: ReviewModel, id: string): FileChange | undefined {
  return isFileItem(id)
    ? model.hunkless.get(id.slice(FILE_ITEM.length))
    : model.hunks.get(id)?.file;
}

/** A file change's review items: its hunks, or the change itself when it has none. */
export function reviewItemIds(file: FileChange): string[] {
  return file.hunks.length > 0 ? file.hunks.map((h) => h.id) : [fileItemId(filePath(file))];
}

/** A node's review items: its hunks, or for the file node of a change with no hunks, the change. */
export function nodeItemIds(model: ReviewModel, node: ChangeNode): string[] {
  if (node.hunkIds.length > 0) return node.hunkIds;
  return node.kind === 'file' && model.hunkless.has(node.path) ? [fileItemId(node.path)] : [];
}

/** The review items whose home is `group` or one of its child groups, each once. */
export function groupItemIds(model: ReviewModel, group: ReviewGroup): string[] {
  const ids = groupNodeIds(model, group).flatMap((id) => {
    const node = model.nodes.get(id);
    return node === undefined ? [] : nodeItemIds(model, node);
  });
  return [...new Set(ids)];
}

/**
 * How many of some review items are marked reviewed (spec D5), and how many of the items are file
 * changes with no hunks rather than hunks.
 */
export interface Progress {
  reviewed: number;
  total: number;
  files: number;
}

/**
 * The progress of `itemIds`, each counted once. A node, group or file is reviewed when all its
 * items are, so a group's progress is that of `groupItemIds()`: its home items, not the items of
 * the nodes it only references.
 */
export function progress(itemIds: readonly string[], reviewed: ReadonlySet<string>): Progress {
  const ids = [...new Set(itemIds)];
  return {
    reviewed: ids.filter((id) => reviewed.has(id)).length,
    total: ids.length,
    files: ids.filter(isFileItem).length,
  };
}

/** Whether `p` is complete. Something with nothing to mark never is. */
export const isReviewed = (p: Progress) => p.total > 0 && p.reviewed === p.total;

/**
 * What `p` counts: `3 hunks`, `1 file` when all are file changes with no hunks, or
 * `4 hunks and files` when it holds both.
 */
export function itemsLabel(p: Progress): string {
  if (p.files === 0) return count(p.total, 'hunk');
  if (p.files === p.total) return count(p.total, 'file');
  return `${p.total.toLocaleString('en')} hunks and files`;
}

/** Whether `group` is the Ungrouped / requires review group (spec D1). */
export const isUngrouped = (group: ReviewGroup) => group.id === UNGROUPED_GROUP_ID;

/** What each capability tier means (design reference §10.8), for tooltips. */
export const TIER_DESCRIPTIONS: Record<CapabilityTier, string> = {
  semantic: 'Semantic: parsed, and a language server answered, so relationships can be verified',
  structural:
    'Structural: parsed, but no language server answered, so relationships are possible at best',
  'git-only': 'Git only: not parsed, so it shows as a diff with no relationships',
};

/** What a partial parse means (#93), for its tooltip. */
export const PARTIAL_PARSE_DESCRIPTION =
  'Parsed partially: the file has syntax errors, and the code around them has no entity, so its hunks are on the file';

/** A language server's status in words (spec D11), e.g. `no language server installed`. */
export const LANGUAGE_STATUS: Record<LanguageCapability['status'], string> = {
  ok: 'language server answered',
  unhealthy: 'language server answered, but the project does not resolve',
  'not-installed': 'no language server installed',
  disabled: 'language servers turned off for this run',
  'needs-opt-in': 'language server not run: it runs project code, which needs an opt-in',
  'not-ready': 'language server never became ready',
  failed: 'language server failed',
};

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

/** Added and removed lines in the patches of `hunks`, together. */
export function lineCounts(hunks: Iterable<DiffHunk>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.patch.split('\n').slice(1)) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

/**
 * The hunk's `@@` line as Git wrote it, with any function context after it: the line its diff
 * shows, so the hunk reads the same everywhere (#108). Git leaves out a one-line range's `,1`.
 */
export function hunkHeader(hunk: DiffHunk): string {
  return hunk.patch.split('\n', 1)[0]!;
}
