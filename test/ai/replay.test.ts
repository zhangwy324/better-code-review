// Every committed recording (recordings/) replayed against the model input as it is now. A
// recording made for another input fails as stale; the test never calls a model to replace it.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ReviewPlan } from '../../src/schemas/index.ts';
import { FIXTURES } from '../fixtures/index.ts';
import { modelInput, TASKS, type Task } from './input.ts';
import { readRecording, RECORDINGS_DIR } from './recording.ts';
import { replayRunner } from './runner.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-replay-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const recordings = readdirSync(RECORDINGS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((p) => p.endsWith('.json'))
  .sort()
  .map((p) => ({ path: p, recording: readRecording(join(RECORDINGS_DIR, p))! }));

describe('recordings', () => {
  if (recordings.length === 0) it.skip('none yet; npm run eval records them', () => {});
  else
    it.each(recordings)('$path is fresh and holds a valid plan', async ({ recording }) => {
      expect(Object.keys(TASKS)).toContain(recording.task);
      const fixture = FIXTURES.find((f) => f.name === recording.fixture);
      expect(fixture, `unknown fixture ${recording.fixture}`).toBeDefined();
      const input = await modelInput(
        recording.task as Task,
        fixture!,
        join(root, recording.fixture),
      );

      const run = await replayRunner(RECORDINGS_DIR).run({ ...input, model: recording.model });
      expect(run.source).toBe('replay');
      ReviewPlan.parse(run.output);
    });
});
