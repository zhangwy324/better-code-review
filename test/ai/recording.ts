// A recorded live run (#85): only what replay needs is committed, under
// `test/ai/recordings/<task>/<fixture>/<model>.json`. The full transcript stays local and
// gitignored (eval.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const RECORDINGS_DIR = fileURLToPath(new URL('recordings', import.meta.url));

export const Usage = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
});

export const Recording = z.strictObject({
  task: z.string().min(1),
  fixture: z.string().min(1),
  /** The model that answered, as it reported itself. */
  model: z.string().min(1),
  /** input.ts `inputHash` at the time of the run; replay rejects any other. */
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  usage: Usage,
  costUsd: z.number().nonnegative(),
  /** The parsed JSON the agent produced. */
  output: z.unknown(),
});

export type Usage = z.infer<typeof Usage>;
export type Recording = z.infer<typeof Recording>;

export function recordingPath(
  dir: string,
  key: { task: string; fixture: string; model: string },
): string {
  return join(dir, key.task, key.fixture, `${key.model}.json`);
}

/** The recording at `path`, or null if there is none. Throws if it is malformed. */
export function readRecording(path: string): Recording | null {
  if (!existsSync(path)) return null;
  return Recording.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeRecording(dir: string, recording: Recording): string {
  const path = recordingPath(dir, recording);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Recording.parse(recording), null, 2)}\n`);
  return path;
}
