// The model input for an AI step on a portfolio fixture (#85), and the hash that ties a recording
// to it. The step is the skill itself (#25): the agent runs in the fixture's repository with the
// skill installed in `.claude/skills/` and the CLI on PATH, follows SKILL.md, and leaves
// `plan.json` in the review directory. The hash covers the task's prompt, the skill's files
// (`HASHED_SOURCES`) and `planner-input.md`, which `generate --no-lsp` writes for the fixture
// exactly as the agent's own run does.
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, targetName } from '../../src/cli/generate.ts';
import { estimateTokens } from '../../src/planner/index.ts';
import type { Fixture } from '../fixtures/fixture.ts';
import { buildFixtureRepo } from '../fixtures/repo.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The tasks an AI step can run, each with its prompt. */
export const TASKS = { skill: 'test/ai/prompts/skill.md' } as const;
export type Task = keyof typeof TASKS;

/** The skill, as the agent client installs it. */
export const SKILL_DIR = 'skills/better-code-review';

/**
 * Repository files whose content changes what the model sees, beyond the prompt and the generated
 * input: the skill's SKILL.md and every reference. A change to any of them makes every recording
 * stale.
 */
export const HASHED_SOURCES: readonly string[] = [
  `${SKILL_DIR}/SKILL.md`,
  ...readdirSync(join(REPO_ROOT, SKILL_DIR, 'references'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${SKILL_DIR}/references/${name}`),
];

/** Files `generate` writes that the model reads; their bytes are hashed. */
export const MODEL_INPUT_FILES = ['planner-input.md'] as const;

export interface ModelInput {
  task: Task;
  fixture: string;
  prompt: string;
  /** The fixture's repository, where the agent runs. */
  cwd: string;
  /** Where the agent's plan lands: `plan.json` in the review directory `generate` picks. */
  outputFile: string;
  /** Environment for the agent: PATH starts with a `better-code-review` that runs this checkout. */
  env: Record<string, string>;
  inputHash: string;
  /** `estimateTokens` over everything hashed. `show` output fetched on demand isn't counted. */
  estimatedTokens: number;
}

/** Builds `fixture` under `dir`, installs the skill and the CLI, and returns the model input. */
export async function modelInput(task: Task, fixture: Fixture, dir: string): Promise<ModelInput> {
  const repo = join(dir, 'repo');
  const { head } = buildFixtureRepo(repo, fixture);
  // Generated outside the repository, only to hash what the agent's own `generate` will show it.
  const review = join(dir, 'review');
  const { changeSet } = await generate({
    repositoryPath: repo,
    target: { kind: 'commit', commit: head },
    outputDirectory: review,
    analysis: { useLsp: false, allowProjectCodeExecution: false },
  });
  cpSync(join(REPO_ROOT, SKILL_DIR), join(repo, '.claude/skills/better-code-review'), {
    recursive: true,
  });
  const bin = installCli(join(dir, 'bin'));

  const prompt = readSource(TASKS[task]);
  const parts: [string, string][] = [
    [TASKS[task], prompt],
    ...HASHED_SOURCES.map((path): [string, string] => [path, readSource(path)]),
    ...MODEL_INPUT_FILES.map((name): [string, string] => [
      `review/${name}`,
      readFileSync(join(review, name), 'utf8'),
    ]),
  ];
  return {
    task,
    fixture: fixture.name,
    prompt,
    cwd: repo,
    outputFile: join(repo, '.better-code-review', 'reviews', targetName(changeSet), 'plan.json'),
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    inputHash: inputHash(parts),
    estimatedTokens: parts.reduce((sum, [, text]) => sum + estimateTokens(text), 0),
  };
}

/**
 * Writes a `better-code-review` command into `bin` that runs this checkout's `src/cli/main.ts`
 * (Node strips the types), so an eval needs no build or install. The `.cmd` is for Windows.
 */
function installCli(bin: string): string {
  const main = join(REPO_ROOT, 'src', 'cli', 'main.ts');
  mkdirSync(bin, { recursive: true });
  const sh = join(bin, 'better-code-review');
  writeFileSync(sh, `#!/bin/sh\nexec node "${main}" "$@"\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(bin, 'better-code-review.cmd'), `@node "${main}" %*\r\n`);
  return bin;
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
