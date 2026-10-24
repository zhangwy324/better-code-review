// `npm run eval:check-current`: the milestone and release gate for the recordings (#131). It
// replays every committed recording and fails on any that is unusable or out of date
// (test/ai/replay.ts). It calls no model, so it needs no approval; re-recording does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RECORDINGS_DIR } from '../test/ai/recording.ts';
import { checkRecordingsCurrent } from '../test/ai/replay.ts';

const work = mkdtempSync(join(tmpdir(), 'bcr-check-recordings-'));
try {
  const ok = await checkRecordingsCurrent(RECORDINGS_DIR, work, (text) =>
    process.stdout.write(text),
  );
  if (!ok)
    console.error(
      '\nEvery recording must be current before a milestone closes or a release is cut.',
    );
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
