// The deterministic half of the planner evaluation (#26, design reference §17.3 M2): checks an
// agent's plan.json on a portfolio fixture. `npm run eval:live` prints the checks for every live run,
// and replay.test.ts asserts them for every committed recording. What needs judgement (are the
// summaries grounded, is the order useful to a person) is scored by hand in
// docs/research/planner-eval.md.
//
// Every plan:
// - `valid`: passes the plan validator (#23), so it names no invented node, edge or hunk, adds
//   no code edge, upgrades nothing to `verified` and cites only real lines.
// - `agent`: was written by the agent, not replaced by the fallback plan after the repair loop.
// - `homed`: gives every node a home, leaving nothing in Ungrouped.
// Then the fixture's own `plan` facts (test/fixtures/fixture.ts): `order`, `together`, `apart`.
// Verdicts are counted, not checked: against the edges the candidate batches ask about (#99).
import type { SnapshotFiles } from '../../src/analysis/semantic/index.ts';
import { selectCandidates, validatePlan } from '../../src/planner/index.ts';
import type { ChangeGraph, ReviewPlan } from '../../src/schemas/index.ts';
import { UNGROUPED_GROUP_ID } from '../../src/schemas/plan.ts';
import { count } from '../../src/text/index.ts';
import { nodeLabels } from '../fixtures/facts.ts';
import type { Fixture } from '../fixtures/fixture.ts';

export interface Check {
  name: string;
  ok: boolean;
  /** Why it failed; empty when it passed. */
  detail: string;
}

export interface PlanScore {
  checks: Check[];
  /** Verdicts, for the record; #43 scores whether they are right. */
  verdicts: VerdictCounts;
}

/**
 * The plan's verdicts against the edges its candidate batches ask about (#99): the candidate
 * selection's `open` edges. A `possible` edge import resolution or the unambiguous rule settled is
 * not asked about, so it rightly gets no verdict.
 */
export interface VerdictCounts {
  /** Edges the batches ask about. */
  asked: number;
  /** Of those, the ones answered `yes`, `no` or `unsure`. */
  yes: number;
  no: number;
  unsure: number;
  /** `possible` edges settled without asking. */
  settled: number;
  /** Open edges over the cap (`MAX_ADJUDICATED_EDGES`), not asked about. */
  notAdjudicated: number;
  /** Verdicts on edges the batches did not ask about. */
  unasked: number;
}

export async function scorePlan(
  fixture: Fixture,
  output: unknown,
  graph: ChangeGraph,
  files: SnapshotFiles,
): Promise<PlanScore> {
  const selection = selectCandidates(graph);
  const verdicts: VerdictCounts = {
    asked: selection.open.length,
    yes: 0,
    no: 0,
    unsure: 0,
    settled: selection.settled.length,
    notAdjudicated: selection.notAdjudicated.length,
    unasked: 0,
  };
  const result = await validatePlan(output, graph, files);
  if (!result.valid) {
    const errors = result.errors.map((e) => `${e.path} ${e.code}: ${e.message}`);
    return { checks: [{ name: 'valid', ok: false, detail: errors.join('; ') }], verdicts };
  }
  const plan = result.plan;
  const asked = new Set(selection.open.map((e) => e.id));
  for (const v of plan.edgeVerdicts) {
    if (asked.has(v.edgeId)) verdicts[v.verdict]++;
    else verdicts.unasked++;
  }

  const labels = nodeLabels(graph);
  const ids = new Map([...labels].map(([id, label]) => [label, id]));
  const id = (label: string) => {
    const found = ids.get(label);
    if (found === undefined) throw new Error(`${fixture.name}: no node is named ${label}`);
    return found;
  };
  const home = homes(plan);
  const groupOf = (label: string) => home.get(id(label))!.group;
  // Left out of every group, or put in a top-level `ungrouped` group by hand.
  const ungrouped = plan.groups.find((g) => g.id === UNGROUPED_GROUP_ID)?.nodeIds ?? [];

  const checks: Check[] = [
    { name: 'valid', ok: true, detail: '' },
    {
      name: 'agent',
      ok: plan.origin === 'agent',
      detail: plan.origin === 'agent' ? '' : `origin is ${plan.origin}: ${plan.fallbackReason}`,
    },
    {
      name: 'homed',
      ok: ungrouped.length === 0,
      detail: ungrouped.map((n) => labels.get(n)).join(', '),
    },
  ];

  const facts = fixture.plan ?? {};
  for (const chain of facts.order ?? []) {
    const late: string[] = [];
    for (let i = 1; i < chain.length; i++) {
      for (const before of chain[i - 1]!) {
        for (const after of chain[i]!) {
          if (compare(home.get(id(before))!, home.get(id(after))!) >= 0) {
            late.push(`${after} (${groupOf(after)}) is read before ${before} (${groupOf(before)})`);
          }
        }
      }
    }
    const name = `order ${chain.map((step) => step.join(', ')).join(' → ')}`;
    checks.push({ name, ok: late.length === 0, detail: late.join('; ') });
  }
  for (const set of facts.together ?? []) {
    const groups = new Set(set.map(groupOf));
    checks.push({
      name: `together ${set.join(', ')}`,
      ok: groups.size === 1,
      detail: groups.size === 1 ? '' : set.map((l) => `${l} in ${groupOf(l)}`).join(', '),
    });
  }
  const apart = facts.apart ?? [];
  for (let i = 0; i < apart.length; i++) {
    for (let j = i + 1; j < apart.length; j++) {
      const shared = new Set(
        apart[i]!.map(groupOf).filter((g) => apart[j]!.map(groupOf).includes(g)),
      );
      checks.push({
        name: `apart ${apart[i]!.join(', ')} | ${apart[j]!.join(', ')}`,
        ok: shared.size === 0,
        detail: shared.size === 0 ? '' : `both in ${[...shared].join(', ')}`,
      });
    }
  }
  return { checks, verdicts };
}

/** Where a node is read: its home group, that group's place in the reading order, and its own. */
interface Place {
  group: string;
  rank: number;
  index: number;
}

/** Every node's place. The validator gives each node a home, `ungrouped` last if need be. */
function homes(plan: ReviewPlan): Map<string, Place> {
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  const reading = plan.groupOrder.flatMap((id) => [id, ...(byId.get(id)?.childGroupIds ?? [])]);
  const places = new Map<string, Place>();
  reading.forEach((group, rank) => {
    byId.get(group)?.nodeIds.forEach((node, index) => places.set(node, { group, rank, index }));
  });
  return places;
}

const compare = (a: Place, b: Place) => a.rank - b.rank || a.index - b.index;

/** One line per check, for `npm run eval:live`. */
export function formatScore({ checks, verdicts }: PlanScore): string {
  const passed = checks.filter((c) => c.ok).length;
  const v = verdicts;
  const notes = [
    `${v.settled} settled without asking`,
    ...(v.notAdjudicated > 0 ? [`${v.notAdjudicated} over the cap`] : []),
    ...(v.unasked > 0 ? [`${count(v.unasked, 'verdict')} on edges not asked about`] : []),
  ];
  const lines = [
    `  checks: ${passed}/${checks.length} pass; verdicts on ${v.yes + v.no + v.unsure}/${v.asked} asked edges (yes ${v.yes}, no ${v.no}, unsure ${v.unsure}); ${notes.join('; ')}`,
    ...checks.filter((c) => !c.ok).map((c) => `  FAIL ${c.name}: ${c.detail}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * An agent plan with one group per entry of `groups`, in that order, each holding the nodes named
 * (as in `PlanFacts`; an unknown name is kept as is). For tests: a plan written without a model.
 */
export function planFromLabels(graph: ChangeGraph, groups: Record<string, string[]>): ReviewPlan {
  const ids = new Map([...nodeLabels(graph)].map(([id, label]) => [label, id]));
  return {
    schemaVersion: 1,
    snapshotId: graph.snapshotId,
    origin: 'agent',
    fallbackReason: null,
    summary: 'A plan written by hand.',
    groups: Object.entries(groups).map(([id, labels]) => ({
      id,
      title: id,
      description: '',
      nodeIds: labels.map((l) => ids.get(l) ?? l),
      referenceNodeIds: [],
      childGroupIds: [],
    })),
    groupOrder: Object.keys(groups),
    edgeVerdicts: [],
    inferredRelationships: [],
  };
}
