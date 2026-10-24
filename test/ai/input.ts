// The model input for an AI step on a portfolio fixture (#85), and the two hashes that tie a
// recording to it (#131). The step is the skill itself (#25): the agent runs in the fixture's
// repository with the skill's planning files installed in `.claude/skills/` and the CLI on PATH,
// follows SKILL.md, and leaves `plan.json` in the review directory.
// - The compatibility hash covers what the fixture gives the agent: `planner-input.md` and the
//   caller-candidate batches (#43), which `generate --no-lsp` writes for the fixture exactly as the
//   agent's own run does, and the graph's IDs. A recording made for another one may cite nodes,
//   hunks or edges that no longer exist, so replay rejects it.
// - The prompt hash covers how the agent is asked: the task's prompt and the skill's files
//   (`HASHED_SOURCES`). A recording made for another one still replays, but is out of date: it no
//   longer shows how the current skill plans. Every recording must be current before a milestone
//   closes or a release is cut (`npm run eval:check-current`).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSnapshotFiles, type SnapshotFiles } from '../../src/analysis/semantic/index.ts';
import { generate, targetName } from '../../src/cli/generate.ts';
import { CANDIDATES_DIR, estimateTokens } from '../../src/planner/index.ts';
import type { ChangeGraph } from '../../src/schemas/index.ts';
import type { Fixture } from '../fixtures/fixture.ts';
import { buildFixtureRepo } from '../fixtures/repo.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The tasks an AI step can run, each with its prompt. */
export const TASKS = { skill: 'test/ai/prompts/skill.md' } as const;
export type Task = keyof typeof TASKS;

/** The skill, as the agent client installs it. */
export const SKILL_DIR = 'skills/better-code-review';

/**
 * Every skill reference, and whether the planner reads it. Only planning references are installed
 * for the agent and hashed, so a reference for another task, such as acting on reviewer feedback
 * (#33), leaves the recordings valid. input.test.ts fails on a reference missing here.
 */
export const REFERENCES: Readonly<Record<string, 'planning' | 'other'>> = {
  'analysis-workflow.md': 'planning',
  'feedback-workflow.md': 'other',
  // Rendering and the report come after `validate`, where the task's prompt stops (prompts/), so
  // they can't change the plan an eval scores.
  'render-workflow.md': 'other',
};

/**
 * Repository files whose content changes what the model sees, beyond the prompt and the generated
 * input: the skill's SKILL.md and its planning references. They are all of the skill the agent
 * gets, and a change to any of them puts every recording out of date.
 */
export const HASHED_SOURCES: readonly string[] = [
  `${SKILL_DIR}/SKILL.md`,
  ...Object.keys(REFERENCES)
    .filter((name) => REFERENCES[name] === 'planning')
    .sort()
    .map((name) => `${SKILL_DIR}/references/${name}`),
];

/**
 * Files `generate` writes that the model reads; their bytes are in the compatibility hash. The
 * caller-candidate batches (#43) in `candidates/` are too, however many there are.
 */
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
  /** The fixture's generated input and graph IDs; replay rejects a recording made for another. */
  compatibilityHash: string;
  /** The task's prompt and the skill; a recording made for another is out of date. */
  promptHash: string;
  /**
   * `estimateTokens` over the prompt, the skill and the generated files. `show` output fetched on
   * demand isn't counted.
   */
  estimatedTokens: number;
  /** The graph the agent plans against and its snapshot, for scoring its plan (score.ts). */
  graph: ChangeGraph;
  files: SnapshotFiles;
}

/** Builds `fixture` under `dir`, installs the skill and the CLI, and returns the model input. */
export async function modelInput(task: Task, fixture: Fixture, dir: string): Promise<ModelInput> {
  const repo = join(dir, 'repo');
  const { head } = buildFixtureRepo(repo, fixture);
  // Generated outside the repository, only to hash what the agent's own `generate` will show it.
  const review = join(dir, 'review');
  const { changeSet, graph } = await generate({
    repositoryPath: repo,
    target: { kind: 'commit', commit: head },
    outputDirectory: review,
    analysis: { useLsp: false, allowProjectCodeExecution: false },
  });
  for (const path of HASHED_SOURCES) {
    const installed = join(repo, '.claude/skills/better-code-review', path.slice(SKILL_DIR.length));
    mkdirSync(dirname(installed), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), installed);
  }
  const bin = installCli(join(dir, 'bin'));

  const prompt = readSource(TASKS[task]);
  const promptParts: [string, string][] = [
    [TASKS[task], prompt],
    ...HASHED_SOURCES.map((path): [string, string] => [path, readSource(path)]),
  ];
  const generated = [...MODEL_INPUT_FILES, ...candidateFiles(review)].map(
    (name): [string, string] => [`review/${name}`, readFileSync(join(review, name), 'utf8')],
  );
  const parts = [...promptParts, ...generated];
  return {
    task,
    fixture: fixture.name,
    prompt,
    cwd: repo,
    outputFile: join(repo, '.better-code-review', 'reviews', targetName(changeSet), 'plan.json'),
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    compatibilityHash: inputHash([...generated, ['graph IDs', graphIds(graph)]]),
    promptHash: inputHash(promptParts),
    estimatedTokens: parts.reduce((sum, [, text]) => sum + estimateTokens(text), 0),
    graph,
    files: gitSnapshotFiles(repo, changeSet),
  };
}

/**
 * The IDs a plan can cite: the snapshot, each node with its hunks, and each edge. `planner-input.md`
 * may not show them all (a large fixture's hunks are cut to its budget), so they are hashed apart.
 */
function graphIds(graph: ChangeGraph): string {
  return JSON.stringify({
    snapshotId: graph.snapshotId,
    nodes: graph.nodes.map((n) => [n.id, n.hunkIds]),
    edges: graph.codeEdges.map((e) => e.id),
  });
}

/** The caller-candidate batches `generate` wrote, in order. */
function candidateFiles(review: string): string[] {
  const dir = join(review, CANDIDATES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => `${CANDIDATES_DIR}/${name}`);
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
