// `npm run eval` (#85): live, budget-capped runs of the skill (#25) on portfolio fixtures. It spends
// real AI usage, so it is opt-in and never part of `npm run check` or CI (AGENTS.md: ask first).
// Each run:
// - passes `--max-budget-usd` to `claude -p`, always;
// - prints its cost and appends it to `.cache/eval/costs.jsonl`;
// - saves its full transcript to `.cache/eval/transcripts/` (gitignored, for debugging);
// - records its output when it is a schema-valid plan (recording.ts), for replay tests, and keeps
//   every valid plan in `.cache/eval/outputs/` (gitignored), which
//   `scripts/score-adjudication.ts` scores against ground truth (#43). `--runs` repeats each
//   fixture, for run-to-run consistency.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ReviewPlan } from '../../src/schemas/index.ts';
import { FIXTURES } from '../fixtures/index.ts';
import { modelInput, type Task } from './input.ts';
import { RECORDINGS_DIR, writeRecording, type Recording } from './recording.ts';
import { type AiRun, LiveRunError, liveRunner, type Spawn } from './runner.ts';

/** Smoke: a cheap model on one small fixture. Quality: the target model on the whole portfolio. */
export const TIERS = {
  smoke: { model: 'claude-haiku-5-5', fixtures: ['signature'] },
  quality: { model: 'claude-sonnet-5-5', fixtures: FIXTURES.map((f) => f.name) },
} as const;
export type Tier = keyof typeof TIERS;

/** Per run. */
export const DEFAULT_BUDGET_USD = 0.25;
/** A per-run budget above this needs `--allow-large-budget`. */
export const LARGE_BUDGET_USD = 1;
/** The skill takes about ten tool calls (generate, read, write, validate, repair). */
export const DEFAULT_MAX_TURNS = 30;

export const EVAL_USAGE = `Usage: npm run eval -- [options]

Live runs of the better-code-review skill with claude -p. This spends real AI usage.

Options:
  --tier smoke|quality     smoke (default): ${TIERS.smoke.model} on ${TIERS.smoke.fixtures.join(', ')}
                           quality: ${TIERS.quality.model} on every fixture
  --fixture <name>         Run this fixture instead (repeatable)
  --model <id>             Use this model instead of the tier's
  --max-budget-usd <usd>   Cap per run (default ${DEFAULT_BUDGET_USD}); always passed to claude
  --allow-large-budget     Allow a cap above ${LARGE_BUDGET_USD} per run
  --max-turns <n>          Cap per run (default ${DEFAULT_MAX_TURNS})
  --runs <n>               Runs per fixture, for consistency (default 1)
`;

export interface EvalArgs {
  tier: Tier;
  task: Task;
  fixtures: string[];
  model: string;
  maxBudgetUsd: number;
  maxTurns: number;
  /** Runs per fixture. */
  runs: number;
}

export class EvalUsageError extends Error {}

export function parseEvalArgs(argv: string[]): EvalArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      tier: { type: 'string', default: 'smoke' },
      fixture: { type: 'string', multiple: true },
      model: { type: 'string' },
      'max-budget-usd': { type: 'string', default: String(DEFAULT_BUDGET_USD) },
      'allow-large-budget': { type: 'boolean', default: false },
      'max-turns': { type: 'string', default: String(DEFAULT_MAX_TURNS) },
      runs: { type: 'string', default: '1' },
    },
    strict: true,
  });
  if (values.tier !== 'smoke' && values.tier !== 'quality') {
    throw new EvalUsageError(`Unknown tier ${values.tier}; use smoke or quality`);
  }
  const tier = TIERS[values.tier];
  const fixtures = values.fixture ?? [...tier.fixtures];
  for (const name of fixtures) {
    if (!FIXTURES.some((f) => f.name === name)) {
      throw new EvalUsageError(`Unknown fixture ${name}; npm run fixtures -- --list shows them`);
    }
  }
  const maxBudgetUsd = Number(values['max-budget-usd']);
  if (!(maxBudgetUsd > 0)) {
    throw new EvalUsageError('--max-budget-usd must be a positive number of dollars');
  }
  if (maxBudgetUsd > LARGE_BUDGET_USD && !values['allow-large-budget']) {
    throw new EvalUsageError(
      `--max-budget-usd ${maxBudgetUsd} is above $${LARGE_BUDGET_USD} per run; pass --allow-large-budget to allow it`,
    );
  }
  const maxTurns = Number(values['max-turns']);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new EvalUsageError('--max-turns must be a positive integer');
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new EvalUsageError('--runs must be a positive integer');
  }
  return {
    tier: values.tier,
    task: 'skill',
    fixtures,
    model: values.model ?? tier.model,
    maxBudgetUsd,
    maxTurns,
    runs,
  };
}

export interface EvalOptions {
  out: (text: string) => void;
  /** Where costs.jsonl and transcripts/ go (default `.cache/eval/`). */
  localDir?: string;
  recordingsDir?: string;
  /** Tests replace the `claude` process. */
  spawn?: Spawn;
  now?: () => Date;
}

const LOCAL_DIR = fileURLToPath(new URL('../../.cache/eval/', import.meta.url));

/** Runs every fixture in `args`; resolves to true when all of them gave a valid plan. */
export async function runEval(args: EvalArgs, options: EvalOptions): Promise<boolean> {
  const localDir = options.localDir ?? LOCAL_DIR;
  const recordingsDir = options.recordingsDir ?? RECORDINGS_DIR;
  const now = options.now ?? (() => new Date());
  const runner = liveRunner({
    maxBudgetUsd: args.maxBudgetUsd,
    maxTurns: args.maxTurns,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });
  mkdirSync(join(localDir, 'transcripts'), { recursive: true });
  mkdirSync(join(localDir, 'outputs'), { recursive: true });
  const worst = args.fixtures.length * args.runs * args.maxBudgetUsd;
  options.out(
    `${args.tier}: ${args.task} with ${args.model} on ${args.fixtures.length} fixture(s)` +
      (args.runs > 1 ? `, ${args.runs} runs each` : '') +
      `, at most $${args.maxBudgetUsd} per run ($${worst.toFixed(2)} in all)\n`,
  );

  let allOk = true;
  let total = 0;
  const runs = args.fixtures.flatMap((name) =>
    Array.from({ length: args.runs }, (_, i) => ({
      name,
      suffix: args.runs > 1 ? `-run${i + 1}` : '',
    })),
  );
  for (const { name, suffix } of runs) {
    const fixture = FIXTURES.find((f) => f.name === name)!;
    const dir = mkdtempSync(join(tmpdir(), `bcr-eval-${name}-`));
    try {
      const input = await modelInput(args.task, fixture, dir);
      const request = { ...input, model: args.model };
      let run: Omit<AiRun, 'output'>;
      let error: string | null = null;
      let kept: Recording | null = null;
      try {
        const done = await runner.run(request);
        run = done;
        const plan = ReviewPlan.safeParse(done.output);
        if (plan.success) {
          kept = {
            task: args.task,
            fixture: name,
            model: done.model,
            inputHash: input.inputHash,
            usage: done.usage,
            costUsd: done.costUsd,
            output: done.output,
          };
          const path = writeRecording(recordingsDir, kept);
          options.out(`  recorded ${path}\n`);
        } else {
          error = `the output is not a valid plan: ${plan.error.issues[0]?.message ?? 'invalid'}`;
        }
      } catch (err) {
        if (!(err instanceof LiveRunError)) throw err;
        run = err.run;
        error = err.message;
      }

      const at = now().toISOString();
      const stamp = `${at.replaceAll(':', '-')}-${name}${suffix}`;
      if (kept !== null) {
        writeFileSync(join(localDir, 'outputs', `${stamp}.json`), `${JSON.stringify(kept)}\n`);
      }
      let transcriptPath: string | null = null;
      if (run.transcript !== undefined) {
        transcriptPath = join(localDir, 'transcripts', `${stamp}.jsonl`);
        writeFileSync(transcriptPath, run.transcript);
      }
      appendFileSync(
        join(localDir, 'costs.jsonl'),
        `${JSON.stringify({
          at,
          tier: args.tier,
          task: args.task,
          fixture: name,
          model: run.model,
          maxBudgetUsd: args.maxBudgetUsd,
          costUsd: run.costUsd,
          usage: run.usage,
          ok: error === null,
          error,
        })}\n`,
      );
      total += run.costUsd;
      const tokens = `${run.usage.inputTokens + run.usage.cacheCreationInputTokens + run.usage.cacheReadInputTokens} in, ${run.usage.outputTokens} out`;
      options.out(
        `${error === null ? 'ok  ' : 'FAIL'} ${name}  ${run.model}  $${run.costUsd.toFixed(4)}  ${tokens}\n`,
      );
      if (error !== null) {
        allOk = false;
        options.out(`  ${error}\n`);
        if (transcriptPath !== null) options.out(`  transcript: ${transcriptPath}\n`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  options.out(`Total cost: $${total.toFixed(4)} (logged to ${join(localDir, 'costs.jsonl')})\n`);
  return allOk;
}
