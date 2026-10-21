// Scoring the AI step's caller verdicts (#43) against ground truth, as #42 measured them:
// precision, recall, false rejections, unsure answers, and run-to-run consistency. No model is
// called here; `npm run eval` produces the plans (saved under `.cache/eval/outputs/`) and
// `scripts/score-adjudication.ts` scores them.
//
// Ground truth is what a language server decides for the same change: for a portfolio fixture,
// its `withLsp` facts (every edge verified unless listed as rejected or possible); for any other
// change, the graph.json `generate` writes with servers installed. An edge it leaves `possible`
// has no truth and is not scored. As #42 found, LSP truth over-approximates dispatch, so a
// disagreement is a lead to audit, not proof of a wrong verdict.
import type { CandidateSelection } from '../../src/planner/index.ts';
import type { ChangeGraph, EdgeVerdict } from '../../src/schemas/index.ts';
import { edgeLabels } from '../fixtures/facts.ts';
import type { Fixture } from '../fixtures/fixture.ts';

/** True for a real relationship, false for none, null when the truth source cannot tell. */
export type Truth = Map<string, boolean | null>;

export interface Score {
  /** Edges the AI step was asked about. */
  asked: number;
  /** Asked edges with truth. The rates below are over these. */
  scored: number;
  /** Scored edges that are real. */
  real: number;
  yes: { correct: number; wrong: number };
  no: { correct: number; wrong: number };
  unsure: number;
  /** Asked edges the plan gave no verdict. */
  missing: number;
  /** Of `yes` answers, the share that are real. Null with no `yes`. */
  precision: number | null;
  /** Of real edges, the share answered `yes`. Null with no real edge. */
  recall: number | null;
  /** Of real edges, the share answered `no`: the error that hides a real caller. */
  falseRejections: number | null;
}

export function scoreVerdicts(
  selection: Pick<CandidateSelection, 'open'>,
  verdicts: readonly EdgeVerdict[],
  truth: Truth,
): Score {
  const byEdge = new Map(verdicts.map((v) => [v.edgeId, v.verdict]));
  const score: Score = {
    asked: selection.open.length,
    scored: 0,
    real: 0,
    yes: { correct: 0, wrong: 0 },
    no: { correct: 0, wrong: 0 },
    unsure: 0,
    missing: 0,
    precision: null,
    recall: null,
    falseRejections: null,
  };
  for (const edge of selection.open) {
    const answer = byEdge.get(edge.id);
    if (answer === undefined) score.missing++;
    const actual = truth.get(edge.id) ?? null;
    if (actual === null) continue;
    score.scored++;
    if (actual) score.real++;
    if (answer === 'yes') score.yes[actual ? 'correct' : 'wrong']++;
    else if (answer === 'no') score.no[actual ? 'wrong' : 'correct']++;
    else if (answer === 'unsure') score.unsure++;
  }
  return withRates(score);
}

/** Adds scores up, recomputing the rates from the totals. */
export function sumScores(scores: readonly Score[]): Score {
  const total = scoreVerdicts({ open: [] }, [], new Map());
  for (const s of scores) {
    total.asked += s.asked;
    total.scored += s.scored;
    total.real += s.real;
    total.yes.correct += s.yes.correct;
    total.yes.wrong += s.yes.wrong;
    total.no.correct += s.no.correct;
    total.no.wrong += s.no.wrong;
    total.unsure += s.unsure;
    total.missing += s.missing;
  }
  return withRates(total);
}

function withRates(score: Score): Score {
  const yes = score.yes.correct + score.yes.wrong;
  score.precision = yes === 0 ? null : score.yes.correct / yes;
  score.recall = score.real === 0 ? null : score.yes.correct / score.real;
  score.falseRejections = score.real === 0 ? null : score.no.wrong / score.real;
  return score;
}

export interface Consistency {
  /** Edges every run was asked about. */
  edges: number;
  /** Edges with the same answer in every run (a missing verdict counts as an answer). */
  identical: number;
  /** Edges answered `yes` in one run and `no` in another: the change that matters. */
  flips: number;
}

/** How often repeated runs on the same input agree (#42: 97.8% identical, no yes↔no flips). */
export function consistency(
  selection: Pick<CandidateSelection, 'open'>,
  runs: readonly (readonly EdgeVerdict[])[],
): Consistency {
  const maps = runs.map((r) => new Map(r.map((v) => [v.edgeId, v.verdict])));
  const out: Consistency = { edges: selection.open.length, identical: 0, flips: 0 };
  for (const edge of selection.open) {
    const answers = new Set(maps.map((m) => m.get(edge.id) ?? 'missing'));
    if (answers.size === 1) out.identical++;
    if (answers.has('yes') && answers.has('no')) out.flips++;
  }
  return out;
}

/** A fixture's ground truth, by edge ID, from its `withLsp` facts (test/fixtures/facts.ts). */
export function fixtureTruth(fixture: Fixture, graph: ChangeGraph): Truth {
  const rejected = new Set(fixture.withLsp?.rejected ?? []);
  const possible = new Set(fixture.withLsp?.possible ?? []);
  const truth: Truth = new Map();
  for (const [id, name] of edgeLabels(graph)) {
    truth.set(id, possible.has(name) ? null : !rejected.has(name));
  }
  return truth;
}

/**
 * Ground truth from the graph of the same change generated with language servers: `verified` is
 * real, an edge the servers rejected (absent there) is not, and `possible` is unknown. Edge IDs
 * do not depend on LSP, so they match the no-LSP graph's.
 */
export function lspTruth(withoutLsp: ChangeGraph, withLsp: ChangeGraph): Truth {
  if (withLsp.snapshotId !== withoutLsp.snapshotId) {
    throw new Error('the two graphs are for different snapshots');
  }
  const there = new Map(withLsp.codeEdges.map((e) => [e.id, e.provenance]));
  const truth: Truth = new Map();
  for (const e of withoutLsp.codeEdges) {
    const p = there.get(e.id);
    truth.set(e.id, p === undefined ? false : p === 'verified' ? true : null);
  }
  return truth;
}

/** The part of a recorded run (recording.ts) scoring reads. */
export interface ScoredRun {
  inputHash: string;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  /** The plan the run produced; only its `edgeVerdicts` are read. */
  output: unknown;
}

/** One fixture and model across its runs: the scores summed, and how the runs agree. */
export interface RunsReport {
  fixture: string;
  model: string;
  runs: number;
  /** Runs made for another input than the current one: scored, but flagged. */
  stale: number;
  score: Score;
  consistency: Consistency;
  costUsd: number;
  /** Per run, on average: input (including cache reads and writes) and output tokens. */
  tokens: { input: number; output: number };
}

export function reportRuns(
  key: { fixture: string; model: string; inputHash: string },
  selection: Pick<CandidateSelection, 'open'>,
  truth: Truth,
  runs: readonly ScoredRun[],
): RunsReport {
  const verdicts = runs.map(
    (r) => (r.output as { edgeVerdicts?: EdgeVerdict[] }).edgeVerdicts ?? [],
  );
  const n = Math.max(1, runs.length);
  const sum = (f: (r: ScoredRun) => number) => runs.reduce((total, r) => total + f(r), 0);
  return {
    fixture: key.fixture,
    model: key.model,
    runs: runs.length,
    stale: runs.filter((r) => r.inputHash !== key.inputHash).length,
    score: sumScores(verdicts.map((v) => scoreVerdicts(selection, v, truth))),
    consistency: consistency(selection, verdicts),
    costUsd: sum((r) => r.costUsd),
    tokens: {
      input: Math.round(
        sum(
          (r) =>
            r.usage.inputTokens + r.usage.cacheCreationInputTokens + r.usage.cacheReadInputTokens,
        ) / n,
      ),
      output: Math.round(sum((r) => r.usage.outputTokens) / n),
    },
  };
}

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);

/** A Markdown table of reports in the shape of #42's results, with a total row. */
export function formatReports(reports: readonly RunsReport[]): string {
  const rows = [
    '| Fixture | Model | Runs | Asked | Scored | Yes ✓/✗ | No ✓/✗ | Unsure | Missing | Precision | Recall | False rejections | Identical | Yes↔no flips | Cost | Tokens in/out per run |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
  ];
  const row = (r: RunsReport) =>
    `| ${r.fixture}${r.stale > 0 ? ` (${r.stale} stale)` : ''} | ${r.model} | ${r.runs} | ` +
    `${r.score.asked} | ${r.score.scored} | ${r.score.yes.correct}/${r.score.yes.wrong} | ` +
    `${r.score.no.correct}/${r.score.no.wrong} | ${r.score.unsure} | ${r.score.missing} | ` +
    `${pct(r.score.precision)} | ${pct(r.score.recall)} | ${pct(r.score.falseRejections)} | ` +
    `${r.consistency.identical}/${r.consistency.edges} | ${r.consistency.flips} | ` +
    `$${r.costUsd.toFixed(4)} | ${r.tokens.input.toLocaleString('en')}/${r.tokens.output.toLocaleString('en')} |`;
  for (const r of reports) rows.push(row(r));
  if (reports.length > 1) {
    const total = (f: (r: RunsReport) => number) => reports.reduce((n, r) => n + f(r), 0);
    rows.push(
      row({
        fixture: '**Total**',
        model: '',
        runs: total((r) => r.runs),
        stale: total((r) => r.stale),
        score: sumScores(reports.map((r) => r.score)),
        consistency: {
          edges: total((r) => r.consistency.edges),
          identical: total((r) => r.consistency.identical),
          flips: total((r) => r.consistency.flips),
        },
        costUsd: total((r) => r.costUsd),
        tokens: { input: total((r) => r.tokens.input), output: total((r) => r.tokens.output) },
      }),
    );
  }
  return `${rows.join('\n')}\n`;
}
