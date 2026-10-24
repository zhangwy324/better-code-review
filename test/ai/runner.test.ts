import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeRecording } from './recording.ts';
import {
  type AiRequest,
  LiveRunError,
  liveArgs,
  IncompatibleRecordingError,
  liveRunner,
  MissingRecordingError,
  parseStream,
  replayRunner,
  type Spawn,
  stubRunner,
} from './runner.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-runner-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HASH = `sha256:${'a'.repeat(64)}`;
const request: AiRequest = {
  task: 'skill',
  fixture: 'signature',
  model: 'claude-haiku-5-5',
  prompt: 'Write a plan.',
  cwd: root,
  outputFile: join(root, 'plan.json'),
  env: { PATH: '/opt/bcr/bin' },
  compatibilityHash: HASH,
};
const usage = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** A stream-json transcript: the init event, one assistant turn and the result event. */
function stream(result: Record<string, unknown>): string {
  return [
    { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', tools: ['Read'] },
    { type: 'assistant', message: { content: [{ type: 'text', text: '…' }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1200, output_tokens: 300 },
      result: '{"ok":true}',
      ...result,
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

/** A `claude` that prints `stdout` and, like the agent, leaves `output` in the output file. */
function fakeSpawn(stdout: string, exitCode = 0, output: string | null = '{"ok":true}') {
  const calls: { command: string; args: readonly string[]; cwd: string; input: string }[] = [];
  const spawn: Spawn = (command, args, { cwd, input, env }) => {
    calls.push({ command, args, cwd, input });
    expect(env).toEqual(request.env);
    rmSync(request.outputFile, { force: true });
    if (output !== null) writeFileSync(request.outputFile, output);
    return Promise.resolve({ exitCode, stdout, stderr: '' });
  };
  return { spawn, calls };
}

describe('stubRunner', () => {
  it('returns the scripted outputs in order, e.g. a bad plan then a good one', async () => {
    const runner = stubRunner([{ bad: true }, { good: true }]);
    expect((await runner.run(request)).output).toEqual({ bad: true });
    expect((await runner.run({ ...request, prompt: 'Repair it.' })).output).toEqual({ good: true });
    expect(runner.requests.map((r) => r.prompt)).toEqual(['Write a plan.', 'Repair it.']);
    await expect(runner.run(request)).rejects.toThrow('call 3, but only 2 scripted');
  });
});

describe('replayRunner', () => {
  const dir = join(root, 'recordings');
  writeRecording(dir, {
    task: 'skill',
    fixture: 'signature',
    model: 'claude-haiku-5-5',
    compatibilityHash: HASH,
    promptHash: HASH,
    usage,
    costUsd: 0.0123,
    output: { recorded: true },
  });

  it('answers from a recording made for the same input', async () => {
    const run = await replayRunner(dir).run(request);
    expect(run).toEqual({
      source: 'replay',
      model: 'claude-haiku-5-5',
      output: { recorded: true },
      usage,
      costUsd: 0.0123,
    });
  });

  it('rejects a recording made for another fixture input', async () => {
    const changed = { ...request, compatibilityHash: `sha256:${'b'.repeat(64)}` };
    const err = await replayRunner(dir)
      .run(changed)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompatibleRecordingError);
    expect((err as Error).message).toContain(
      'npm run eval -- --fixture signature --model claude-haiku-5-5',
    );
  });

  it('reports a missing recording', async () => {
    await expect(
      replayRunner(dir).run({ ...request, fixture: 'ten-callers' }),
    ).rejects.toBeInstanceOf(MissingRecordingError);
  });
});

describe('liveRunner', () => {
  it('always passes the budget and turn caps, and sends the prompt on stdin', async () => {
    const { spawn, calls } = fakeSpawn(stream({}));
    const run = await liveRunner({ maxBudgetUsd: 0.25, maxTurns: 10, spawn }).run(request);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe('claude');
    expect(call?.cwd).toBe(root);
    expect(call?.input).toBe('Write a plan.');
    const args = call?.args.join(' ');
    expect(args).toContain('-p --model claude-haiku-5-5 --max-turns 10 --max-budget-usd 0.25');
    expect(args).toContain('--output-format stream-json --verbose');
    expect(args).toContain('--allowedTools Read,Write,Edit,Bash(better-code-review:*)');

    expect(run.output).toEqual({ ok: true });
    expect(run.costUsd).toBe(0.0123);
    expect(run.usage).toEqual(usage);
    expect(run.model).toBe('claude-haiku-5-5');
    expect(run.transcript).toBe(stream({}));
  });

  it('refuses to run without a positive budget', () => {
    expect(() => liveArgs(request, { maxBudgetUsd: 0, maxTurns: 10 })).toThrow('--max-budget-usd');
  });

  it('fails a run that wrote no output file', async () => {
    const { spawn } = fakeSpawn(stream({}), 0, null);
    await expect(
      liveRunner({ maxBudgetUsd: 0.25, maxTurns: 10, spawn }).run(request),
    ).rejects.toThrow('the agent wrote no');
  });

  it('fails a run that hit its budget, with what it cost', async () => {
    const { spawn } = fakeSpawn(
      stream({ subtype: 'error_max_budget_usd', is_error: true, result: undefined }),
      1,
    );
    const err = await liveRunner({ maxBudgetUsd: 0.25, maxTurns: 10, spawn })
      .run(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveRunError);
    expect((err as LiveRunError).message).toContain('error_max_budget_usd');
    expect((err as LiveRunError).run.costUsd).toBe(0.0123);
  });

  it('fails a run that hit an API error, saying why', async () => {
    const { spawn } = fakeSpawn(
      stream({ is_error: true, result: "You've hit your session limit" }),
      1,
    );
    await expect(
      liveRunner({ maxBudgetUsd: 0.25, maxTurns: 10, spawn }).run(request),
    ).rejects.toThrow("Live run failed: You've hit your session limit");
  });

  it('fails a run whose output file is not JSON', async () => {
    const { spawn } = fakeSpawn(stream({}), 0, 'Here is the plan you asked for.');
    await expect(
      liveRunner({ maxBudgetUsd: 0.25, maxTurns: 10, spawn }).run(request),
    ).rejects.toThrow('not JSON');
  });
});

describe('parseStream', () => {
  it('reports a stream with no result event as failed', () => {
    expect(parseStream('{"type":"system","subtype":"init","model":"m"}\nnot json\n')).toMatchObject(
      {
        model: 'm',
        error: 'the stream has no result event',
        costUsd: 0,
      },
    );
  });
});
