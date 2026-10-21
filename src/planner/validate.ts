// The plan validator (#23, design reference §8.6, §9.8): checks a plan.json the agent wrote
// against the graph and snapshot it was planned from, and gives every homeless node a home. The
// agent runs it through `better-code-review validate` and repairs its plan until it passes (the
// repair loop, #25). A plan that still fails is replaced by the fallback plan (D8, #24).
//
// The rules, in the order they are checked:
// - The plan matches the schema. It is strict, so unknown fields (code text, a `provenance` on a
//   verdict) are rejected, and no verdict can say `verified` (D6).
// - The plan is for the graph's snapshot, and an agent plan has no `fallbackReason`.
// - Group and inferred relationship IDs are unique; `ungrouped` is reserved for top-level use.
// - Every node a group lists exists, and has at most one home group (D2). A group may list a
//   node homed elsewhere in `referenceNodeIds`, so groups overlap but coverage stays unambiguous.
// - Groups nest one level (D2): a child exists, is not the group itself, has no children of its
//   own and has one parent. `groupOrder` lists every top-level group exactly once.
// - Verdicts are on existing `possible` edges, one per edge, so the plan neither adds code edges
//   nor relabels a `verified` one. `via` is only set on a `yes`.
// - Inferred relationships join existing nodes. Every cited line exists in the snapshot: in a
//   changed file or, since `show --file` lets the agent read them, an unchanged one.
//
// Every node with no home goes into the `ungrouped` group (D1), which is made, last in
// `groupOrder`, when needed. Since every hunk is on a node (graph invariant 2), every hunk is then
// visible somewhere. A valid plan whose nodes all have homes comes back unchanged.
//
// Errors are machine-readable: a JSON Pointer to the offending value in plan.json, a stable code,
// and a message that says what to change.
import type { SnapshotFiles } from '../analysis/semantic/snapshot-files.ts';
import type { LineRef } from '../schemas/common.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import {
  ReviewPlan,
  UNGROUPED_GROUP_ID,
  UNGROUPED_TITLE,
  type ReviewGroup,
} from '../schemas/plan.ts';

export type PlanErrorCode =
  | 'json'
  | 'schema'
  | 'snapshot'
  | 'origin'
  | 'duplicate-id'
  | 'reserved-id'
  | 'unknown-id'
  | 'multiple-homes'
  | 'nesting'
  | 'group-order'
  | 'verdict'
  | 'citation';

export interface PlanError {
  /** JSON Pointer (RFC 6901) to the value in plan.json, e.g. `/groups/0/nodeIds/2`. */
  path: string;
  code: PlanErrorCode;
  message: string;
}

export type PlanValidation =
  | {
      valid: true;
      /** The plan with every homeless node in the `ungrouped` group. */
      plan: ReviewPlan;
      /** The nodes the plan gave no home, now in `ungrouped`. */
      ungroupedNodeIds: string[];
    }
  | { valid: false; errors: PlanError[] };

export async function validatePlan(
  data: unknown,
  graph: ChangeGraph,
  files: SnapshotFiles,
): Promise<PlanValidation> {
  const parsed = ReviewPlan.safeParse(data);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: pointer(issue.path),
        code: 'schema',
        message:
          issue.code === 'unrecognized_keys'
            ? `${issue.message}. Remove them: the plan cannot carry code, provenance or other fields`
            : issue.message,
      })),
    };
  }
  const plan = parsed.data;
  const cited = [
    ...plan.edgeVerdicts.map((v) => v.citedLine),
    ...plan.inferredRelationships.flatMap((r) => r.citedLines),
  ];
  const lineCounts = new Map<string, number | null>();
  for (const { side, path } of cited) {
    const key = `${side}:${path}`;
    if (!lineCounts.has(key)) lineCounts.set(key, lineCount(await files.read(side, path)));
  }
  const errors = planErrors(plan, graph, (line) => lineCounts.get(`${line.side}:${line.path}`)!);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, ...homeEveryNode(plan, graph) };
}

function planErrors(
  plan: ReviewPlan,
  graph: ChangeGraph,
  lineCountOf: (line: LineRef) => number | null,
): PlanError[] {
  const out: PlanError[] = [];
  const error = (path: (string | number)[], code: PlanErrorCode, message: string) =>
    out.push({ path: pointer(path), code, message });

  if (plan.snapshotId !== graph.snapshotId) {
    error(['snapshotId'], 'snapshot', `must be ${graph.snapshotId}, the graph's snapshot`);
  }
  if (plan.origin === 'agent' && plan.fallbackReason !== null) {
    error(['fallbackReason'], 'origin', 'must be null in a plan the agent wrote');
  }

  const nodes = new Set(graph.nodes.map((n) => n.id));
  const groups = new Map<string, ReviewGroup>();
  plan.groups.forEach((group, i) => {
    if (groups.has(group.id)) {
      error(['groups', i, 'id'], 'duplicate-id', `group ID ${group.id} is used twice; rename one`);
    } else {
      groups.set(group.id, group);
    }
  });

  // Homes and references (D2).
  const homes = new Map<string, string>();
  plan.groups.forEach((group, i) => {
    const listed = new Set<string>();
    group.nodeIds.forEach((id, j) => {
      const at = ['groups', i, 'nodeIds', j];
      if (!nodes.has(id)) return error(at, 'unknown-id', `node ${id} is not in graph.json`);
      const home = homes.get(id);
      if (home === group.id) {
        error(at, 'multiple-homes', `node ${id} is listed twice in group ${group.id}`);
      } else if (home !== undefined) {
        error(
          at,
          'multiple-homes',
          `node ${id} already has its home in group ${home}; move it to this group's referenceNodeIds`,
        );
      } else {
        homes.set(id, group.id);
      }
      listed.add(id);
    });
    group.referenceNodeIds.forEach((id, j) => {
      const at = ['groups', i, 'referenceNodeIds', j];
      if (!nodes.has(id)) error(at, 'unknown-id', `node ${id} is not in graph.json`);
      else if (listed.has(id)) {
        error(at, 'multiple-homes', `node ${id} is already in this group's nodeIds; drop one`);
      }
    });
  });

  // Nesting, one level (D2).
  const parents = new Map<string, string>();
  plan.groups.forEach((group, i) => {
    group.childGroupIds.forEach((id, j) => {
      const at = ['groups', i, 'childGroupIds', j];
      const child = groups.get(id);
      const parent = parents.get(id);
      if (child === undefined) error(at, 'unknown-id', `group ${id} is not in groups`);
      else if (id === group.id) error(at, 'nesting', `group ${id} cannot contain itself`);
      else if (id === UNGROUPED_GROUP_ID) {
        error(at, 'reserved-id', `group ${UNGROUPED_GROUP_ID} must be top-level`);
      } else if (child.childGroupIds.length > 0) {
        error(at, 'nesting', `group ${id} has children of its own; groups nest one level only`);
      } else if (parent !== undefined) {
        error(at, 'nesting', `group ${id} is already a child of group ${parent}`);
      } else {
        parents.set(id, group.id);
      }
    });
  });

  // Reading order of the top-level groups.
  const ordered = new Set<string>();
  plan.groupOrder.forEach((id, i) => {
    const at = ['groupOrder', i];
    if (!groups.has(id)) error(at, 'unknown-id', `group ${id} is not in groups`);
    else if (parents.has(id)) {
      error(
        at,
        'group-order',
        `group ${id} is a child of ${parents.get(id)}; list only top-level groups`,
      );
    } else if (ordered.has(id)) error(at, 'group-order', `group ${id} is listed twice`);
    ordered.add(id);
  });
  for (const id of groups.keys()) {
    if (!parents.has(id) && !ordered.has(id)) {
      error(['groupOrder'], 'group-order', `top-level group ${id} is missing; add it`);
    }
  }

  // Verdicts label existing `possible` edges (D6).
  const edges = new Map(graph.codeEdges.map((e) => [e.id, e]));
  const judged = new Set<string>();
  plan.edgeVerdicts.forEach((v, i) => {
    const edge = edges.get(v.edgeId);
    if (edge === undefined) {
      error(
        ['edgeVerdicts', i, 'edgeId'],
        'unknown-id',
        `edge ${v.edgeId} is not in graph.json; verdicts only label existing code edges`,
      );
    } else if (edge.provenance !== 'possible') {
      error(
        ['edgeVerdicts', i, 'edgeId'],
        'verdict',
        `edge ${v.edgeId} is already ${edge.provenance}; only possible edges take a verdict`,
      );
    } else if (judged.has(v.edgeId)) {
      error(
        ['edgeVerdicts', i, 'edgeId'],
        'verdict',
        `edge ${v.edgeId} has two verdicts; keep one`,
      );
    }
    judged.add(v.edgeId);
    if (v.verdict !== 'yes' && v.via !== null) {
      error(['edgeVerdicts', i, 'via'], 'verdict', `must be null when the verdict is ${v.verdict}`);
    }
    citation(['edgeVerdicts', i, 'citedLine'], v.citedLine);
  });

  // Inferred relationships stay apart from code edges and cite real lines.
  const relationships = new Set<string>();
  plan.inferredRelationships.forEach((r, i) => {
    if (relationships.has(r.id)) {
      error(
        ['inferredRelationships', i, 'id'],
        'duplicate-id',
        `relationship ID ${r.id} is used twice; rename one`,
      );
    }
    relationships.add(r.id);
    for (const end of ['from', 'to'] as const) {
      if (!nodes.has(r[end])) {
        error(
          ['inferredRelationships', i, end],
          'unknown-id',
          `node ${r[end]} is not in graph.json`,
        );
      }
    }
    r.citedLines.forEach((line, j) =>
      citation(['inferredRelationships', i, 'citedLines', j], line),
    );
  });

  function citation(at: (string | number)[], line: LineRef) {
    const count = lineCountOf(line);
    const where = `${line.path} (${line.side})`;
    if (count === null) {
      error(at, 'citation', `${where} is not a text file in the snapshot on that side`);
    } else if (line.line > count) {
      error(at, 'citation', `${where} has ${count} lines, so it has no line ${line.line}`);
    }
  }
  return out;
}

/** The plan with every node that has no home group added to `ungrouped` (D1). */
function homeEveryNode(
  plan: ReviewPlan,
  graph: ChangeGraph,
): { plan: ReviewPlan; ungroupedNodeIds: string[] } {
  const homed = new Set(plan.groups.flatMap((g) => g.nodeIds));
  const ungroupedNodeIds = graph.nodes.map((n) => n.id).filter((id) => !homed.has(id));
  if (ungroupedNodeIds.length === 0) return { plan, ungroupedNodeIds };

  const existing = plan.groups.find((g) => g.id === UNGROUPED_GROUP_ID);
  const ungrouped: ReviewGroup = existing
    ? { ...existing, nodeIds: [...existing.nodeIds, ...ungroupedNodeIds] }
    : {
        id: UNGROUPED_GROUP_ID,
        title: UNGROUPED_TITLE,
        description: 'Changes the plan did not place in a group.',
        nodeIds: ungroupedNodeIds,
        referenceNodeIds: [],
        childGroupIds: [],
      };
  return {
    plan: {
      ...plan,
      groups: existing
        ? plan.groups.map((g) => (g === existing ? ungrouped : g))
        : [...plan.groups, ungrouped],
      groupOrder: existing ? plan.groupOrder : [...plan.groupOrder, UNGROUPED_GROUP_ID],
    },
    ungroupedNodeIds,
  };
}

/** The number of lines in a file's content, or null for no content. */
function lineCount(content: string | null): number | null {
  if (content === null) return null;
  const lines = content.split('\n');
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

/** A JSON Pointer (RFC 6901) for a path into the plan. */
function pointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${String(p).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
