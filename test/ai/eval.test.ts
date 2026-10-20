// `npm run eval` with the `claude` process replaced: no model is called.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET_USD, type EvalArgs, parseEvalArgs, runEval, TIERS } from './eval.ts';
import { readRecording, recordingPath } from './recording.ts';
import type { Spawn } from './runner.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-eval-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parseEvalArgs', () => {
  it('defaults to the smoke tier with a low budget', () => {
    expect(parseEvalArgs([])).toEqual({
      tier: 'smoke',
      task: 'plan',
      fixtures: ['signature'],
      model: TIERS.smoke.model,
      maxBudgetUsd: DEFAULT_BUDGET_USD,
      maxTurns: 10,
    });
  });

  it('runs the whole portfolio on the target model for the quality tier', () => {
    const args = parseEvalArgs(['--tier', 'quality']);
    expect(args.model).toBe(TIERS.quality.model);
    expect(args.fixtures.length).toBeGreaterThan(10);
  });

  it('takes fixtures and a model', () => {
    expect(
      parseEvalArgs(['--fixture', 'same-name', '--fixture', 'signature', '--model', 'm']),
    ).toMatchObject({ fixtures: ['same-name', 'signature'], model: 'm' });
  });

  it('needs an explicit flag for a large budget', () => {
    expect(() => parseEvalArgs(['--max-budget-usd', '5'])).toThrow('--allow-large-budget');
    expect(parseEvalArgs(['--max-budget-usd', '5', '--allow-large-budget']).maxBudgetUsd).toBe(5);
  });

  it('rejects a bad budget, fixture or tier', () => {
    expect(() => parseEvalArgs(['--max-budget-usd', '0'])).toThrow('positive');
    expect(() => parseEvalArgs(['--max-budget-usd', 'lots'])).toThrow('positive');
    expect(() => parseEvalArgs(['--fixture', 'nope'])).toThrow('Unknown fixture nope');
    expect(() => parseEvalArgs(['--tier', 'huge'])).toThrow('Unknown tier');
  });
});

/** A `claude` that answers with `answer(planner-input.md)` and reports a cost. */
function fakeClaude(answer: (snapshotId: string) => string): Spawn {
  return (_command, args, { cwd }) => {
    expect(args).toContain('--max-budget-usd');
    const input = readFileSync(join(cwd, 'planner-input.md'), 'utf8');
    const snapshotId = /^Snapshot: (\S+)$/m.exec(input)?.[1] ?? '';
    const events = [
      { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.01,
        usage: { input_tokens: 2000, output_tokens: 400 },
        result: answer(snapshotId),
      },
    ];
    return Promise.resolve({
      exitCode: 0,
      stdout: events.map((e) => JSON.stringify(e)).join('\n'),
      stderr: '',
    });
  };
}

const validPlan = (snapshotId: string) =>
  JSON.stringify({
    schemaVersion: 1,
    snapshotId,
    origin: 'agent',
    fallbackReason: null,
    summary: 'A signature change.',
    groups: [],
    groupOrder: [],
    edgeVerdicts: [],
    inferredRelationships: [],
  });

const args: EvalArgs = parseEvalArgs([]);

describe('runEval', () => {
  it('records a valid plan, logs its cost and keeps the transcript', async () => {
    const dir = join(root, 'valid');
    let printed = '';
    const ok = await runEval(args, {
      out: (t) => (printed += t),
      localDir: join(dir, 'local'),
      recordingsDir: join(dir, 'recordings'),
      spawn: fakeClaude(validPlan),
      now: () => new Date('2026-10-20T12:00:00Z'),
    });

    expect(ok).toBe(true);
    expect(printed).toContain('at most $0.25 each');
    expect(printed).toMatch(/ok {3}signature {2}claude-haiku-5-5 {2}\$0\.0100/);
    expect(printed).toContain('Total cost: $0.0100');

    const recording = readRecording(
      recordingPath(join(dir, 'recordings'), {
        task: 'plan',
        fixture: 'signature',
        model: 'claude-haiku-5-5',
      }),
    );
    expect(recording).toMatchObject({ costUsd: 0.01, usage: { inputTokens: 2000 } });
    expect(recording?.inputHash).toMatch(/^sha256:/);

    const [logLine] = readFileSync(join(dir, 'local', 'costs.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(JSON.parse(logLine!)).toMatchObject({
      fixture: 'signature',
      costUsd: 0.01,
      maxBudgetUsd: 0.25,
      ok: true,
    });
    expect(readdirSync(join(dir, 'local', 'transcripts'))).toEqual([
      '2026-10-20T12-00-00.000Z-signature.jsonl',
    ]);
  });

  it('fails an invalid plan without recording it, and still logs the cost', async () => {
    const dir = join(root, 'invalid');
    let printed = '';
    const ok = await runEval(args, {
      out: (t) => (printed += t),
      localDir: join(dir, 'local'),
      recordingsDir: join(dir, 'recordings'),
      spawn: fakeClaude(() => '{"groups": "none"}'),
    });

    expect(ok).toBe(false);
    expect(printed).toContain('FAIL signature');
    expect(printed).toContain('not a valid plan');
    expect(printed).toContain('transcript: ');
    expect(existsSync(join(dir, 'recordings'))).toBe(false);
    expect(readFileSync(join(dir, 'local', 'costs.jsonl'), 'utf8')).toContain('"ok":false');
  });
});
