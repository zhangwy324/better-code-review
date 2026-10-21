// Every committed recording (recordings/) replayed against the model input as it is now. A
// recording made for another input fails as stale; the test never calls a model to replace it.
// Its plan is scored by the planner checks (score.ts, #26): it fails exactly the checks listed for
// it in KNOWN_FAILS, so a failing plan stays committed for review without failing the suite.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReviewPlan } from '../../src/schemas/index.ts';
import { FIXTURES } from '../fixtures/index.ts';
import { modelInput, TASKS, type Task } from './input.ts';
import { readRecording, RECORDINGS_DIR } from './recording.ts';
import { replayRunner } from './runner.ts';
import { scorePlan } from './score.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-replay-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const recordings = readdirSync(RECORDINGS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((p) => p.endsWith('.json'))
  .sort()
  .map((p, i) => ({
    i,
    path: p.replaceAll('\\', '/'),
    recording: readRecording(join(RECORDINGS_DIR, p))!,
  }));

/**
 * The checks each committed recording is known to fail, reviewed in
 * docs/research/planner-eval.md. Keep it exact: a new failure or a fixed one fails the test.
 */
const KNOWN_FAILS: Record<string, string[]> = {};

describe('recordings', () => {
  if (recordings.length === 0) it.skip('none yet; npm run eval records them', () => {});
  else
    it.each(recordings)('$path is fresh and scores as known', async ({ i, path, recording }) => {
      expect(Object.keys(TASKS)).toContain(recording.task);
      const fixture = FIXTURES.find((f) => f.name === recording.fixture);
      expect(fixture, `unknown fixture ${recording.fixture}`).toBeDefined();
      const input = await modelInput(recording.task as Task, fixture!, join(root, String(i)));

      const run = await replayRunner(RECORDINGS_DIR).run({ ...input, model: recording.model });
      expect(run.source).toBe('replay');
      ReviewPlan.parse(run.output);
      const { checks } = await scorePlan(fixture!, run.output, input.graph, input.files);
      const failed = checks.filter((c) => !c.ok);
      expect(
        failed.map((c) => c.name),
        JSON.stringify(failed, null, 2),
      ).toEqual(KNOWN_FAILS[path] ?? []);
    });
});
