// Every committed recording (recordings/) replayed against the model input as it is now (replay.ts).
// An unusable recording fails; one made for another prompt or skill passes but is reported as out
// of date (#131). The test never calls a model to replace either. Its plan is scored by the planner
// checks (score.ts, #26): it fails exactly the checks listed for it in KNOWN_FAILS, so a failing
// plan stays committed for review without failing the suite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRecordings, RECORDINGS_DIR, writeRecording, type Recording } from './recording.ts';
import { checkRecordingsCurrent, outOfDateMessage, replayRecording } from './replay.ts';
import { IncompatibleRecordingError } from './runner.ts';
import { scorePlan } from './score.ts';
import { FIXTURES } from '../fixtures/index.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-replay-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const recordings = readRecordings(RECORDINGS_DIR).map((r, i) => ({ i, ...r }));

/**
 * The checks each committed recording is known to fail, reviewed in
 * docs/research/planner-eval.md. Keep it exact: a new failure or a fixed one fails the test.
 */
const KNOWN_FAILS: Record<string, string[]> = {};

describe('recordings', () => {
  if (recordings.length === 0) it.skip('none yet; npm run eval records them', () => {});
  else
    it.each(recordings)('$path is usable and scores as known', async ({ i, path, recording }) => {
      const { input, plan, current } = await replayRecording(
        RECORDINGS_DIR,
        recording,
        join(root, String(i)),
      );
      if (!current) console.warn(outOfDateMessage(path, recording));
      const fixture = FIXTURES.find((f) => f.name === recording.fixture)!;
      const { checks } = await scorePlan(fixture, plan, input.graph, input.files);
      const failed = checks.filter((c) => !c.ok);
      expect(
        failed.map((c) => c.name),
        JSON.stringify(failed, null, 2),
      ).toEqual(KNOWN_FAILS[path] ?? []);
    });
});

// The two kinds of drift, on a copy of one committed recording. Changing a prompt-side input
// (the task prompt, SKILL.md or a planning reference) changes only the prompt hash; changing the
// fixture's planner input or graph changes the compatibility hash.
describe.runIf(recordings.length > 0)('a recording', () => {
  const base = recordings[0]!.recording;
  let n = 0;
  /** A recordings directory holding only `recording`. */
  function only(recording: Recording): string {
    const dir = join(root, `drift-${n++}`);
    writeRecording(dir, recording);
    return dir;
  }
  const otherHash = `sha256:${'0'.repeat(64)}`;

  it('made for another prompt or skill replays but is out of date, and fails the gate', async () => {
    const outdated = { ...base, promptHash: otherHash };
    const dir = only(outdated);
    const replayed = await replayRecording(dir, outdated, join(root, `drift-${n++}`));
    expect(replayed.current).toBe(false);

    let printed = '';
    const ok = await checkRecordingsCurrent(dir, join(root, `drift-${n++}`), (t) => (printed += t));
    expect(ok).toBe(false);
    expect(printed).toContain(`STALE ${outOfDateMessage(recordings[0]!.path, outdated)}`);
  });

  it('that is current passes the gate', async () => {
    // Current even while the committed one is out of date.
    const { input } = await replayRecording(only(base), base, join(root, `drift-${n++}`));
    const current = { ...base, promptHash: input.promptHash };
    const dir = only(current);
    let printed = '';
    expect(
      await checkRecordingsCurrent(dir, join(root, `drift-${n++}`), (t) => (printed += t)),
    ).toBe(true);
    expect(printed).not.toMatch(/STALE|FAIL/);
  });

  it('made for another planner input or graph is unusable', async () => {
    const incompatible = { ...base, compatibilityHash: otherHash };
    const dir = only(incompatible);
    await expect(
      replayRecording(dir, incompatible, join(root, `drift-${n++}`)),
    ).rejects.toBeInstanceOf(IncompatibleRecordingError);
    let printed = '';
    expect(
      await checkRecordingsCurrent(dir, join(root, `drift-${n++}`), (t) => (printed += t)),
    ).toBe(false);
    expect(printed).toContain('FAIL  skill/');
  });

  it('whose plan no longer parses is unusable', async () => {
    const unparseable = { ...base, output: { ...(base.output as object), groups: 'none' } };
    const dir = only(unparseable);
    await expect(replayRecording(dir, unparseable, join(root, `drift-${n++}`))).rejects.toThrow();
  });
});
