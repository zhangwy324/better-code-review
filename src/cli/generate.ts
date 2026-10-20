// `better-code-review generate` (#20, design reference §4.2, §8.1): extracts a target's ChangeSet,
// runs the structural and semantic analyzers, builds the graph and writes the deterministic
// outputs, with no model involved (D8).
//
// Output (D9): `.better-code-review/reviews/<target>/` at the repository root, unless
// `outputDirectory` is given. It holds `changes.json`, `graph.json` and `summary.txt`, the
// capability and coverage summary that is also printed. A rerun on the same target overwrites
// them. The first run with the default location adds `.better-code-review/` to
// `.git/info/exclude`, never to a tracked `.gitignore`.
//
// Language servers (D11) need the new side on disk. For `local` that is the working tree itself.
// For `commit`, `range` and `pr` the head commit is checked out into a temporary worktree,
// removed afterwards; it has no `node_modules`, so servers come from PATH and the project's
// dependencies may not resolve, which only stops rejections (the health check). No hooks run on
// that checkout, and Git LFS does not download objects for it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  analyzeSemantics,
  gitSnapshotFiles,
  type LspOptions,
  LspSession,
  type SnapshotFiles,
} from '../analysis/semantic/index.ts';
import { analyzeStructure } from '../analysis/structural/analyze.ts';
import { declaredTestRoots, type TestRoots } from '../analysis/structural/test-files.ts';
import { extractChangeSet, type ExtractOptions } from '../git/extract.ts';
import { gitLine, runGit } from '../git/run.ts';
import { buildGraph, hunkCoverage } from '../graph/index.ts';
import type { ChangeGraph, ChangeSet, ReviewRequest, ReviewTarget } from '../schemas/index.ts';

/** A ReviewRequest whose output directory may be left to the D9 default. */
export type GenerateRequest = Omit<ReviewRequest, 'outputDirectory'> & {
  outputDirectory: string | null;
};

export interface GenerateOptions {
  /** Test hooks for the extractor (e.g. a fake `gh`). */
  extract?: ExtractOptions;
  /** Extra LSP options (tests set `searchPath` and `timeouts`). */
  lsp?: Omit<LspOptions, 'enabled' | 'allowProjectCode'>;
  /** Progress messages, one line each. */
  progress?: (message: string) => void;
}

export interface GenerateResult {
  outputDirectory: string;
  changeSet: ChangeSet;
  graph: ChangeGraph;
  summary: string;
}

const OUTPUT_ROOT = '.better-code-review';

export async function generate(
  request: GenerateRequest,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const progress = options.progress ?? (() => {});
  const repo = await gitLine(request.repositoryPath, ['rev-parse', '--show-toplevel']);

  progress('Extracting the change from Git');
  const changeSet = await extractChangeSet(repo, request.target, options.extract);
  const files = gitSnapshotFiles(repo, changeSet);

  progress('Analysing structure');
  const structure = await analyzeStructure(changeSet, { testRoots: await testRoots(files) });

  const languages = [
    ...new Set(structure.files.flatMap((f) => (f.language === null ? [] : [f.language]))),
  ];
  let evidence;
  if (request.analysis.useLsp && languages.length > 0) {
    progress(`Starting language servers for ${languages.join(', ')}`);
    evidence = await withNewSide(repo, changeSet, async (root) => {
      const lsp = await LspSession.start(root, languages, {
        ...options.lsp,
        allowProjectCode: request.analysis.allowProjectCodeExecution,
      });
      try {
        progress('Searching for relationships between changed entities');
        return await analyzeSemantics(changeSet, structure, { files, lsp });
      } finally {
        await lsp.close();
      }
    });
  } else {
    progress('Searching for relationships between changed entities');
    evidence = await analyzeSemantics(changeSet, structure, { files });
  }

  const graph = buildGraph(changeSet, { structure, evidence });

  let outputDirectory: string;
  if (request.outputDirectory === null) {
    outputDirectory = join(repo, OUTPUT_ROOT, 'reviews', targetName(changeSet));
    await excludeOutputRoot(repo);
  } else {
    outputDirectory = resolve(request.outputDirectory);
  }
  const summary = summarise(changeSet, graph);
  mkdirSync(outputDirectory, { recursive: true });
  writeJson(join(outputDirectory, 'changes.json'), changeSet);
  writeJson(join(outputDirectory, 'graph.json'), graph);
  writeFileSync(join(outputDirectory, 'summary.txt'), summary);
  return { outputDirectory, changeSet, graph, summary };
}

/** `<target>` of the default output directory (D9). */
export function targetName(changeSet: ChangeSet): string {
  const short = (id: string | null) => (id ?? 'root').slice(0, 7);
  const target: ReviewTarget = changeSet.target;
  switch (target.kind) {
    case 'pr':
      return `pr-${target.number}`;
    case 'commit':
      return `commit-${short(changeSet.headRevision)}`;
    case 'range':
      return `range-${short(changeSet.baseRevision)}-${short(changeSet.headRevision)}`;
    case 'local':
      return `local-${short(changeSet.snapshotId)}`;
  }
}

/**
 * Test roots declared in the new side's config. `declaredTestRoots` reads synchronously and its
 * file list is fixed, so a first pass with nothing found collects the paths to read.
 */
async function testRoots(files: SnapshotFiles): Promise<TestRoots> {
  const paths: string[] = [];
  declaredTestRoots((path) => (paths.push(path), null));
  const contents = new Map<string, string | null>();
  for (const path of paths) contents.set(path, await files.read('new', path));
  return declaredTestRoots((path) => contents.get(path) ?? null);
}

/** Runs `use` with a directory holding the new side of `changeSet`. */
async function withNewSide<T>(
  repo: string,
  changeSet: ChangeSet,
  use: (root: string) => Promise<T>,
): Promise<T> {
  if (changeSet.headRevision === null) return use(repo);
  const dir = mkdtempSync(join(tmpdir(), 'bcr-head-'));
  const tree = join(dir, 'tree');
  try {
    await runGit(
      repo,
      [
        '-c',
        `core.hooksPath=${devNull}`,
        'worktree',
        'add',
        '--detach',
        '--quiet',
        tree,
        changeSet.headRevision,
      ],
      '',
      { GIT_LFS_SKIP_SMUDGE: '1' },
    );
    return await use(tree);
  } finally {
    // Only this worktree: `git worktree prune` would also drop the user's own stale ones. If the
    // add failed there is nothing to remove; if the removal fails, Git prunes it in a later gc.
    await runGit(repo, ['worktree', 'remove', '--force', tree]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds `.better-code-review/` to `.git/info/exclude` unless it is already listed. */
async function excludeOutputRoot(repo: string): Promise<void> {
  const exclude = resolve(repo, await gitLine(repo, ['rev-parse', '--git-path', 'info/exclude']));
  let text = '';
  try {
    text = readFileSync(exclude, 'utf8');
  } catch {
    // No exclude file yet.
  }
  const entry = `/${OUTPUT_ROOT}/`;
  if (
    text
      .split(/\r?\n/)
      .some((line) => [entry, `${OUTPUT_ROOT}/`, OUTPUT_ROOT].includes(line.trim()))
  ) {
    return;
  }
  mkdirSync(dirname(exclude), { recursive: true });
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  writeFileSync(exclude, `${text}${separator}${entry}\n`);
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

/** The human-readable capability and coverage summary (summary.txt). */
export function summarise(changeSet: ChangeSet, graph: ChangeGraph): string {
  const lines: string[] = [];
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tally = <T extends string>(items: readonly T[]) => {
    const counts = new Map<T, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
  };

  lines.push(`Target    ${describeTarget(changeSet)}`);
  lines.push(`Snapshot  ${changeSet.snapshotId}`);

  const omitted = changeSet.files.flatMap((f) => (f.contentOmitted ? [f.contentOmitted] : []));
  lines.push(
    `Files     ${count(changeSet.files.length, 'changed file')}` +
      (omitted.length > 0 ? ` (content omitted: ${tally(omitted)})` : ''),
  );
  const { mapped, total } = hunkCoverage(graph, changeSet);
  lines.push(`Hunks     ${mapped}/${total} hunks mapped`);
  lines.push(
    `Nodes     ${graph.nodes.length > 0 ? tally(graph.nodes.map((n) => n.kind)) : 'none'}`,
  );
  lines.push(
    `Edges     ${graph.codeEdges.length > 0 ? tally(graph.codeEdges.map((e) => e.provenance)) : 'none'}`,
  );
  if (graph.files.length > 0) {
    lines.push(`Analysis  ${tally(graph.files.map((f) => f.capabilityTier))}`);
  }
  const tests = graph.files.filter((f) => f.test !== null);
  if (tests.length > 0) {
    lines.push(`Tests     ${tests.map((f) => f.path).join(', ')}`);
  }

  if (graph.languages.length > 0) {
    lines.push('', 'Language servers');
    const width = Math.max(...graph.languages.map((l) => l.language.length));
    for (const l of graph.languages) {
      const server = l.server
        ? `${l.server.name}${l.server.version ? ` ${l.server.version}` : ''}` +
          (l.server.configuration ? ` (${l.server.configuration})` : '')
        : null;
      const detail = [server, l.guidance].filter(Boolean).join('; ');
      lines.push(`  ${l.language.padEnd(width)}  ${l.status}${detail ? `  ${detail}` : ''}`);
    }
  }

  if (graph.caps.length > 0) {
    lines.push('', 'Capped fan-out');
    const nodeOf = new Map(graph.nodes.map((n) => [n.entityId, n.displayName]));
    for (const cap of graph.caps) {
      const name = nodeOf.get(cap.entityId) ?? cap.entityId;
      lines.push(`  ${name} ${cap.relation}: showing ${cap.shown} of ${cap.total}`);
    }
  }

  const notes: string[] = [];
  if (changeSet.excludedUntrackedPaths.length > 0) {
    notes.push(
      `${count(changeSet.excludedUntrackedPaths.length, 'untracked file')} not included ` +
        '(rerun without --no-untracked to include them).',
    );
  }
  for (const warning of changeSet.warnings) notes.push(`Extraction warning: ${warning}.`);
  notes.push(
    'Only relationships between changed code are shown. Unchanged callers are not analysed.',
  );
  lines.push('', ...notes);
  return `${lines.join('\n')}\n`;
}

function describeTarget(changeSet: ChangeSet): string {
  const short = (id: string | null) => (id === null ? 'the empty tree' : id.slice(0, 7));
  const range = `${short(changeSet.baseRevision)}..${short(changeSet.headRevision)}`;
  const target = changeSet.target;
  switch (target.kind) {
    case 'pr':
      return `pull request #${target.number} (${range})`;
    case 'commit':
      return `commit ${short(changeSet.headRevision)} (against ${short(changeSet.baseRevision)})`;
    case 'range':
      return `range ${target.base}${target.mode === 'direct' ? '..' : '...'}${target.head} (${range})`;
    case 'local':
      return `local changes against ${changeSet.baseRevision === null ? 'an unborn branch' : short(changeSet.baseRevision)}`;
  }
}

/** `path` relative to `from` when it is inside it, for display. */
export function displayPath(from: string, path: string): string {
  const rel = relative(from, path);
  return rel === '' || rel.startsWith('..') || resolve(from, rel) !== path ? path : rel;
}
