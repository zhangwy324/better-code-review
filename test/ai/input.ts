// The model input for an AI step on a portfolio fixture (#85), and the hash that ties a recording
// to it. The input is what `generate --no-lsp` writes for the fixture, read through
// `planner-input.md` (#22), plus the task's prompt and the files listed in `HASHED_SOURCES`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../../src/cli/generate.ts';
import { estimateTokens } from '../../src/planner/index.ts';
import type { Fixture } from '../fixtures/fixture.ts';
import { buildFixtureRepo } from '../fixtures/repo.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The tasks an AI step can run, each with its prompt. */
export const TASKS = { plan: 'test/ai/prompts/plan.md' } as const;
export type Task = keyof typeof TASKS;

/**
 * Repository files whose content changes what the model sees, beyond the prompt and the generated
 * input. A change to any of them makes every recording stale. Add the skill here when it lands
 * (#25): `skills/better-code-review/SKILL.md` and its `references/*.md`.
 */
export const HASHED_SOURCES: readonly string[] = [];

/** Files `generate` writes that the model reads; their bytes are hashed. */
export const MODEL_INPUT_FILES = ['planner-input.md'] as const;

export interface ModelInput {
  task: Task;
  fixture: string;
  prompt: string;
  /** The review directory `generate` wrote, where the agent runs. */
  cwd: string;
  inputHash: string;
  /** `estimateTokens` over everything hashed. `show` output fetched on demand isn't counted. */
  estimatedTokens: number;
}

/** Builds `fixture` under `dir`, runs `generate --no-lsp` on it and returns the model input. */
export async function modelInput(task: Task, fixture: Fixture, dir: string): Promise<ModelInput> {
  const { head } = buildFixtureRepo(join(dir, 'repo'), fixture);
  const cwd = join(dir, 'review');
  await generate({
    repositoryPath: join(dir, 'repo'),
    target: { kind: 'commit', commit: head },
    outputDirectory: cwd,
    analysis: { useLsp: false, allowProjectCodeExecution: false },
  });
  const prompt = readSource(TASKS[task]);
  const parts: [string, string][] = [
    [TASKS[task], prompt],
    ...HASHED_SOURCES.map((path): [string, string] => [path, readSource(path)]),
    ...MODEL_INPUT_FILES.map((name): [string, string] => [
      `review/${name}`,
      readFileSync(join(cwd, name), 'utf8'),
    ]),
  ];
  return {
    task,
    fixture: fixture.name,
    prompt,
    cwd,
    inputHash: inputHash(parts),
    estimatedTokens: parts.reduce((sum, [, text]) => sum + estimateTokens(text), 0),
  };
}

/** sha256 over named parts, in order. Names are hashed too, so moving content changes it. */
export function inputHash(parts: readonly (readonly [string, string])[]): string {
  const hash = createHash('sha256');
  for (const [name, content] of parts) {
    hash.update(`${name}\0${content.length}\0${content}\0`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** A repository file with line endings normalised, so a Windows checkout hashes the same. */
function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8').replaceAll('\r\n', '\n');
}
