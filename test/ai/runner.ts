// The one call every test of an AI step goes through (#85). `plan.json` and the caller verdicts
// are the boundary (MVP spec D8): the CLI makes no model calls, so everything on either side is
// tested without a model, through one of three runners:
// - `stubRunner`: scripted outputs, in order, e.g. a bad plan then a good one for the repair loop
//   (#23). It never spawns anything.
// - `replayRunner`: a recorded real run (recording.ts). A missing or stale recording is an error;
//   it never falls through to a live call.
// - `liveRunner`: headless `claude -p`, always with `--max-budget-usd`. Only `npm run eval` uses
//   it, never `npm run check` or CI.
import { spawn } from 'node:child_process';
import { readRecording, recordingPath, type Recording, type Usage } from './recording.ts';

/** One AI step to run: the task, the fixture it runs on, and its full model input. */
export interface AiRequest {
  /** What the agent produces; recordings are kept per task. */
  task: string;
  fixture: string;
  model: string;
  prompt: string;
  /** The directory the agent runs in, holding the files the prompt names. */
  cwd: string;
  /** Hash of the model input (input.ts); a recording with another hash is stale. */
  inputHash: string;
}

export interface AiRun {
  source: 'stub' | 'replay' | 'live';
  /** The model that answered, as it reported itself. */
  model: string;
  /** The parsed JSON the agent produced (a plan, or verdicts). */
  output: unknown;
  usage: Usage;
  costUsd: number;
  /** Live runs only: the stream-json transcript, for the gitignored local copy. */
  transcript?: string;
}

export interface Runner {
  run(request: AiRequest): Promise<AiRun>;
}

const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Returns `outputs` one per call, in order, and keeps the requests for assertions. */
export function stubRunner(outputs: readonly unknown[]): Runner & { requests: AiRequest[] } {
  const requests: AiRequest[] = [];
  return {
    requests,
    run(request) {
      requests.push(request);
      if (requests.length > outputs.length) {
        return Promise.reject(
          new Error(`stub runner: call ${requests.length}, but only ${outputs.length} scripted`),
        );
      }
      return Promise.resolve({
        source: 'stub',
        model: 'stub',
        output: outputs[requests.length - 1],
        usage: NO_USAGE,
        costUsd: 0,
      });
    },
  };
}

export class MissingRecordingError extends Error {}
export class StaleRecordingError extends Error {}

/** The command that records `request` again, for error messages. */
export const recordCommand = (request: Pick<AiRequest, 'fixture' | 'model'>) =>
  `npm run eval -- --fixture ${request.fixture} --model ${request.model}`;

/** Answers from the recordings under `dir`. Never calls a model. */
export function replayRunner(dir: string): Runner {
  return {
    run(request) {
      const path = recordingPath(dir, request);
      let recording: Recording | null;
      try {
        recording = readRecording(path);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      if (recording === null) {
        return Promise.reject(
          new MissingRecordingError(
            `No recording at ${path}; record one with ${recordCommand(request)}`,
          ),
        );
      }
      if (recording.inputHash !== request.inputHash) {
        return Promise.reject(
          new StaleRecordingError(
            `Recording ${path} is stale: it was made for input ${recording.inputHash}, the input is now ` +
              `${request.inputHash}. Record it again with ${recordCommand(request)}`,
          ),
        );
      }
      return Promise.resolve({
        source: 'replay',
        model: recording.model,
        output: recording.output,
        usage: recording.usage,
        costUsd: recording.costUsd,
      });
    },
  };
}

/** Runs `command args` in `cwd` with `input` on stdin. Tests replace it. */
export type Spawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; input: string },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface LiveOptions {
  /** Passed as `--max-budget-usd` on every run. */
  maxBudgetUsd: number;
  maxTurns: number;
  spawn?: Spawn;
}

/** A live run that produced no usable output. It still carries what it cost. */
export class LiveRunError extends Error {
  readonly run: Omit<AiRun, 'output'>;
  constructor(message: string, run: Omit<AiRun, 'output'>) {
    super(message);
    this.run = run;
  }
}

/** The `claude` arguments for a live run; the prompt goes on stdin. */
export function liveArgs(request: AiRequest, options: LiveOptions): string[] {
  if (!(options.maxBudgetUsd > 0)) throw new Error('A live run needs a positive --max-budget-usd');
  return [
    '-p',
    '--model',
    request.model,
    '--max-turns',
    String(options.maxTurns),
    '--max-budget-usd',
    String(options.maxBudgetUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    // Only reading the input files; no user settings, MCP servers or saved session.
    '--tools',
    'Read',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
  ];
}

/** Headless `claude -p`. The stream is the transcript; its final `result` event has usage and cost. */
export function liveRunner(options: LiveOptions): Runner {
  const run = options.spawn ?? spawnProcess;
  return {
    async run(request) {
      const args = liveArgs(request, options);
      const { exitCode, stdout, stderr } = await run('claude', args, {
        cwd: request.cwd,
        input: request.prompt,
      });
      const stream = parseStream(stdout);
      const spent = {
        source: 'live' as const,
        model: stream.model ?? request.model,
        usage: stream.usage,
        costUsd: stream.costUsd,
        transcript: stdout,
      };
      if (stream.error !== null || exitCode !== 0) {
        const why = stream.error ?? `claude exited with ${exitCode}: ${stderr.trim()}`;
        throw new LiveRunError(`Live run failed: ${why}`, spent);
      }
      let output: unknown;
      try {
        output = JSON.parse(stripFence(stream.result));
      } catch {
        throw new LiveRunError('Live run failed: the final answer is not JSON', spent);
      }
      return { ...spent, output };
    },
  };
}

export interface StreamSummary {
  model: string | null;
  /** The final answer text. */
  result: string;
  usage: Usage;
  costUsd: number;
  /** Why the run failed (a `result` error subtype such as `error_max_budget_usd`), or null. */
  error: string | null;
}

/** Reads a `--output-format stream-json` transcript: the `system` init event and the `result` event. */
export function parseStream(stdout: string): StreamSummary {
  const summary: StreamSummary = {
    model: null,
    result: '',
    usage: NO_USAGE,
    costUsd: 0,
    error: 'the stream has no result event',
  };
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
      summary.model = event.model;
    } else if (event.type === 'result') {
      const u = event.usage ?? {};
      summary.usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
      };
      summary.costUsd = event.total_cost_usd ?? 0;
      summary.result = event.result ?? '';
      summary.error =
        event.subtype === 'success' && event.is_error !== true ? null : (event.subtype ?? 'error');
    }
  }
  return summary;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  model?: unknown;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Drops a Markdown code fence around the whole answer, which models add despite being asked not to. */
function stripFence(text: string): string {
  const m = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m?.[1] ?? text;
}

const spawnProcess: Spawn = (command, args, { cwd, input }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
