// `better-code-review generate` (#20, design reference §4.2, §8.1): extracts a target's ChangeSet,
// runs the structural and semantic analyzers, builds the graph and writes the deterministic
// outputs, with no model involved (D8).
//
// Output (D9): `.better-code-review/reviews/<target>/` at the repository root, unless
// `outputDirectory` is given. It holds `changes.json`, `graph.json`, `planner-input.md` (the
// planner's model input, #22), `candidates/batch-<n>.md` (the caller candidates the agent judges,
// #43, when there are any), `plan.json` (the deterministic fallback plan, #24, which the agent
// replaces with its own), `summary.txt`, the capability and coverage summary that is also
// printed, and `review.html` (#34), the review page with the fallback plan, so the CLI alone goes
// from target to artifact. `render` rewrites it once the agent's plan is in. A rerun on the same
// target overwrites them. The first run with the default location
// adds `.better-code-review/` to `.git/info/exclude`, never to a tracked `.gitignore`.
//
// Language servers (D11) need the new side on disk. For `local` that is the working tree itself.
// For `commit`, `range` and `pr` the head commit is written to a temporary directory
// (src/git/checkout.ts), removed afterwards. When old-side candidates need a server too (#66),
// the base revision is written the same way, for every target including `local`. A checkout has
// no installed `node_modules`, so servers come from PATH and the project's dependencies may not
// resolve, which only stops rejections (the health check). No hooks run, and Git LFS does not
// download objects.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  analyzeSemantics,
  gitSnapshotFiles,
  type LspOptions,
  LspSession,
  type SnapshotFiles,
} from '../analysis/semantic/index.ts';
import { analyzeStructure } from '../analysis/structural/analyze.ts';
import { declaredTestRoots, type TestRoots } from '../analysis/structural/test-files.ts';
import { checkoutRevision } from '../git/checkout.ts';
import { extractChangeSet, type ExtractOptions } from '../git/extract.ts';
import { describeTarget } from '../git/describe.ts';
import { gitLine } from '../git/run.ts';
import { buildGraph, hunkCoverage } from '../graph/index.ts';
import {
  CANDIDATES_DIR,
  candidateBatches,
  fallbackPlan,
  plannerInput,
  type Candidates,
  type PlannerInput,
} from '../planner/index.ts';
import { REVIEW_FILE, ViewerNotBuiltError, writeReview } from '../renderer/render.ts';
import {
  type ChangeGraph,
  type ChangeSet,
  type ReviewPlan,
  type ReviewRequest,
  type ReviewTarget,
} from '../schemas/index.ts';
import { count, occurrences, UNCHANGED_CALLERS_NOTE } from '../text/index.ts';

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
  /** The viewer page review.html is made from (tests); by default the built one. */
  viewerTemplate?: string;
}

export interface GenerateResult {
  outputDirectory: string;
  changeSet: ChangeSet;
  graph: ChangeGraph;
  planner: PlannerInput;
  /** The caller candidates for the agent to judge (#43), written to `candidates/`. */
  candidates: Candidates;
  /** The fallback plan written as plan.json. */
  plan: ReviewPlan;
  summary: string;
  /** review.html, or null when the viewer is not built (a checkout without `npm run build`). */
  reviewPath: string | null;
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
    const lspOptions = {
      ...options.lsp,
      allowProjectCode: request.analysis.allowProjectCodeExecution,
    };
    const base = changeSet.baseRevision;
    const old: { dir?: string; session?: LspSession } = {};
    const oldLsp = async (needed: string[]) => {
      progress(`Starting language servers on the base side for ${needed.join(', ')}`);
      old.dir = mkdtempSync(join(tmpdir(), 'bcr-base-'));
      const root = join(old.dir, 'tree');
      await checkoutRevision(repo, base!, root);
      old.session = await LspSession.start(root, needed, lspOptions);
      return old.session;
    };
    evidence = await withNewSide(repo, changeSet, async (root) => {
      const lsp = await LspSession.start(root, languages, lspOptions);
      try {
        progress('Searching for relationships between changed entities');
        return await analyzeSemantics(changeSet, structure, {
          files,
          lsp,
          ...(base === null ? {} : { oldLsp }),
        });
      } finally {
        await lsp.close();
        await old.session?.close();
        if (old.dir !== undefined) rmSync(old.dir, { recursive: true, force: true });
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
  const candidates = await candidateBatches(structure, graph, files);
  const planner = plannerInput(changeSet, graph, { candidates });
  const plan = fallbackPlan(graph);
  const summary = summarise(changeSet, graph, planner, plan, candidates);
  mkdirSync(outputDirectory, { recursive: true });
  writeJson(join(outputDirectory, 'changes.json'), changeSet);
  writeJson(join(outputDirectory, 'graph.json'), graph);
  writeFileSync(join(outputDirectory, 'planner-input.md'), planner.text);
  // A rerun may have fewer batches than the last run: never leave a stale one behind.
  rmSync(join(outputDirectory, CANDIDATES_DIR), { recursive: true, force: true });
  if (candidates.batches.length > 0) mkdirSync(join(outputDirectory, CANDIDATES_DIR));
  for (const batch of candidates.batches) {
    writeFileSync(join(outputDirectory, batch.file), batch.text);
  }
  writeJson(join(outputDirectory, 'plan.json'), plan);
  writeFileSync(join(outputDirectory, 'summary.txt'), summary);
  const reviewPath = writeReviewIfBuilt(outputDirectory, options.viewerTemplate);
  return { outputDirectory, changeSet, graph, planner, candidates, plan, summary, reviewPath };
}

/** Writes review.html, or removes a stale one when there is no viewer to write it with. */
function writeReviewIfBuilt(dir: string, template: string | undefined): string | null {
  try {
    return writeReview(dir, { template });
  } catch (err) {
    if (!(err instanceof ViewerNotBuiltError)) throw err;
    rmSync(join(dir, REVIEW_FILE), { force: true });
    return null;
  }
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
  try {
    const tree = join(dir, 'tree');
    await checkoutRevision(repo, changeSet.headRevision, tree);
    return await use(tree);
  } finally {
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
export function summarise(
  changeSet: ChangeSet,
  graph: ChangeGraph,
  planner: PlannerInput,
  plan: ReviewPlan,
  candidates?: Candidates,
): string {
  const lines: string[] = [];
  // `2 symbol, 1 file`: counts first, unlike the planner input's `tally()`.
  const tally = (items: readonly string[]) =>
    occurrences(items)
      .map(([k, n]) => `${n.toLocaleString('en')} ${k}`)
      .join(', ');

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
  const { hunks } = planner;
  lines.push(
    `Planner   ~${planner.estimatedTokens.toLocaleString('en')} estimated tokens, ` +
      `${hunks.inlined}/${hunks.total} hunks inlined` +
      (hunks.truncated > 0 ? ` (${hunks.truncated} truncated)` : '') +
      (planner.redactions > 0 ? `, ${count(planner.redactions, 'secret')} redacted` : ''),
  );
  if (candidates !== undefined) {
    const { open, notAdjudicated, settled } = candidates.selection;
    const batches = candidates.batches.length;
    lines.push(
      `Judge     ${count(open.length, 'possible edge')}` +
        (batches > 0 ? ` in ${count(batches, 'batch', 'batches')}` : '') +
        `, ${settled.length.toLocaleString('en')} settled without AI` +
        (notAdjudicated.length > 0
          ? `, ${notAdjudicated.length.toLocaleString('en')} not adjudicated (over the cap)`
          : '') +
        (candidates.redactions > 0 ? `, ${count(candidates.redactions, 'secret')} redacted` : ''),
    );
  }
  lines.push(
    `Plan      fallback, ${count(plan.groups.length, 'group')} (an agent replaces plan.json with its own)`,
  );
  const tests = graph.files.filter((f) => f.test !== null);
  if (tests.length > 0) {
    lines.push(`Tests     ${tests.map((f) => f.path).join(', ')}`);
  }

  if (graph.languages.length > 0) {
    lines.push('', 'Language servers');
    // A base-side session (#66) gets its own entries.
    const label = (l: ChangeGraph['languages'][number]) =>
      l.side === 'old' ? `${l.language} (old side)` : l.language;
    const width = Math.max(...graph.languages.map((l) => label(l).length));
    for (const l of graph.languages) {
      const server = l.server
        ? `${l.server.name}${l.server.version ? ` ${l.server.version}` : ''}` +
          (l.server.configuration ? ` (${l.server.configuration})` : '')
        : null;
      const detail = [server, l.guidance].filter(Boolean).join('; ');
      lines.push(`  ${label(l).padEnd(width)}  ${l.status}${detail ? `  ${detail}` : ''}`);
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
  notes.push(UNCHANGED_CALLERS_NOTE);
  lines.push('', ...notes);
  return `${lines.join('\n')}\n`;
}

/**
 * `path` relative to `from` when it is inside it, for display. Both are compared as real paths:
 * Git reports the repository root with symlinks resolved (`/private/var` on macOS) and with `/`
 * on Windows, so it need not match the working directory as typed.
 */
export function displayPath(from: string, path: string): string {
  const rel = relative(realpathSync.native(from), realpathSync.native(path));
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}
