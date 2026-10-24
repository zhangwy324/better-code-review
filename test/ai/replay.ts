// Replaying a committed recording (recording.ts) against the model input as it is now (#131).
// A recording is unusable, and replay throws, when it can't be replayed meaningfully: its fixture
// input changed (the compatibility hash, input.ts) or its plan no longer parses. One made for
// another prompt or skill still replays but is out of date. `npm test` reports those
// (replay.test.ts); `npm run eval:check-current`, the milestone and release gate, fails on them.
import { join } from 'node:path';
import { ReviewPlan } from '../../src/schemas/index.ts';
import { FIXTURES } from '../fixtures/index.ts';
import { modelInput, TASKS, type ModelInput, type Task } from './input.ts';
import { readRecordings, type Recording } from './recording.ts';
import { recordCommand, replayRunner } from './runner.ts';

export interface Replayed {
  input: ModelInput;
  plan: ReviewPlan;
  /** False when the prompt or the skill changed since the recording was made. */
  current: boolean;
}

/** Replays `recording` from `dir`, building its fixture under `work`. Throws if it is unusable. */
export async function replayRecording(
  dir: string,
  recording: Recording,
  work: string,
): Promise<Replayed> {
  if (!Object.keys(TASKS).includes(recording.task)) {
    throw new Error(`Unknown task ${recording.task}`);
  }
  const fixture = FIXTURES.find((f) => f.name === recording.fixture);
  if (fixture === undefined) throw new Error(`Unknown fixture ${recording.fixture}`);
  const input = await modelInput(recording.task as Task, fixture, work);
  const run = await replayRunner(dir).run({ ...input, model: recording.model });
  return {
    input,
    plan: ReviewPlan.parse(run.output),
    current: recording.promptHash === input.promptHash,
  };
}

/** Why `recording` is out of date, and the command that records it again. */
export const outOfDateMessage = (path: string, recording: Recording) =>
  `${path} is out of date: the prompt or the skill changed since it was recorded. ` +
  `Before a milestone closes or a release is cut, record it again with ${recordCommand(recording)}`;

/**
 * The milestone and release gate: replays every recording under `dir` and resolves to true only
 * when all of them are usable and current. Calls no model.
 */
export async function checkRecordingsCurrent(
  dir: string,
  work: string,
  out: (text: string) => void,
): Promise<boolean> {
  let ok = true;
  for (const [i, { path, recording }] of readRecordings(dir).entries()) {
    try {
      const { current } = await replayRecording(dir, recording, join(work, String(i)));
      if (current) {
        out(`ok    ${path}\n`);
        continue;
      }
      out(`STALE ${outOfDateMessage(path, recording)}\n`);
    } catch (err) {
      out(`FAIL  ${path} is unusable: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    ok = false;
  }
  return ok;
}
