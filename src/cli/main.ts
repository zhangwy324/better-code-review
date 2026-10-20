#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { changeSetFiles, gitSnapshotFiles } from '../analysis/semantic/index.ts';
import { gitLine } from '../git/run.ts';
import { show, ShowError, type ShowQuery } from '../planner/index.ts';
import { ChangeGraph, ChangeSet, RepoPath, type ReviewTarget } from '../schemas/index.ts';
import { displayPath, generate, type GenerateOptions } from './generate.ts';

/** Where `run` writes, and the directory it runs in. */
export interface Io {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Exit codes: success, a failed run (Git, gh, the repository, the file system), bad usage. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

const USAGE = `Usage: better-code-review [--help] [--version]
       better-code-review generate <target> [options]
       better-code-review show --dir <dir> (<id> | --file <path> [--side old|new] [--lines a-b])

generate writes changes.json, graph.json, planner-input.md and summary.txt for a Git change,
with no AI involved. show prints more context from a generated review for the planner: a hunk,
node or edge by ID, or lines of any file in the snapshot. Secrets are redacted in both.

Targets (exactly one):
  --local              The working tree (staged, unstaged and untracked) against HEAD
  --commit <rev>       One commit against its parent
  --range <a>..<b>     The diff from <a> to <b>
  --range <a>...<b>    The diff from the merge base of <a> and <b> to <b>
  --pr <number>        A GitHub pull request (needs the gh CLI)

Options:
  --parent <n>         With --commit: which parent to diff against (default 1)
  --no-untracked       With --local: leave untracked files out (they are listed)
  --no-lsp             Do not use installed language servers; nothing is verified
  --allow-project-code Allow language servers that run project code (e.g. jdtls with Gradle)
  --out <dir>          Output directory (default .better-code-review/reviews/<target>/)

show options:
  --dir <dir>          The directory generate wrote
  --file <path>        A repository-relative file, changed or not
  --side old|new       The side of the snapshot to read (default new)
  --lines <a>-<b>      The lines to print (default the first 400)

Exit codes: 0 success, 1 the run failed, 2 bad usage.
`;

export function version(): string {
  // Same relative path from src/cli/ and dist/cli/.
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string };
  return pkg.version;
}

class UsageError extends Error {}

export async function run(argv: string[], io: Io, options: GenerateOptions = {}): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === 'generate') return await runGenerate(rest, io, options);
    if (command === 'show') return await runShow(rest, io);
    const { values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
    });
    if (values.version) io.out(`${version()}\n`);
    else io.out(USAGE);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof UsageError || isParseArgsError(err)) {
      io.err(`${(err as Error).message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failed;
  }
}

async function runGenerate(argv: string[], io: Io, options: GenerateOptions): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      local: { type: 'boolean' },
      commit: { type: 'string' },
      range: { type: 'string' },
      pr: { type: 'string' },
      parent: { type: 'string' },
      untracked: { type: 'boolean', default: true },
      lsp: { type: 'boolean', default: true },
      'allow-project-code': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
    allowNegative: true,
    strict: true,
  });
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }

  const targets = (['local', 'commit', 'range', 'pr'] as const).filter(
    (t) => values[t] !== undefined,
  );
  if (targets.length !== 1) {
    throw new UsageError(
      targets.length === 0
        ? 'generate needs a target: --local, --commit, --range or --pr'
        : `Choose one target, not ${targets.map((t) => `--${t}`).join(' and ')}`,
    );
  }
  if (values.parent !== undefined && values.commit === undefined) {
    throw new UsageError('--parent only applies to --commit');
  }
  if (values.untracked === false && !values.local) {
    throw new UsageError('--no-untracked only applies to --local');
  }

  let target: ReviewTarget;
  if (values.local) {
    target = { kind: 'local', includeUntracked: values.untracked };
  } else if (values.commit !== undefined) {
    target = { kind: 'commit', commit: nonEmpty('--commit', values.commit) };
    if (values.parent !== undefined) target.parent = positiveInt('--parent', values.parent);
  } else if (values.range !== undefined) {
    target = parseRange(values.range);
  } else {
    target = { kind: 'pr', number: positiveInt('--pr', values.pr!) };
  }

  const result = await generate(
    {
      repositoryPath: io.cwd,
      target,
      outputDirectory: values.out ?? null,
      analysis: {
        useLsp: values.lsp,
        allowProjectCodeExecution: values['allow-project-code'],
      },
    },
    { progress: (message) => io.err(`${message}…\n`), ...options },
  );
  io.out(`${result.summary}\nWritten to ${displayPath(io.cwd, result.outputDirectory)}\n`);
  return EXIT.ok;
}

async function runShow(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      dir: { type: 'string' },
      file: { type: 'string' },
      side: { type: 'string', default: 'new' },
      lines: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (values.dir === undefined)
    throw new UsageError('show needs --dir, the directory generate wrote');
  if ((values.file === undefined) === (positionals.length !== 1)) {
    throw new UsageError('show needs exactly one ID, or --file <path>');
  }
  if (values.file === undefined && (values.lines !== undefined || argv.includes('--side'))) {
    throw new UsageError('--side and --lines only apply to --file');
  }
  if (values.side !== 'new' && values.side !== 'old') {
    throw new UsageError(`--side must be old or new, got ${values.side}`);
  }

  let query: ShowQuery;
  if (values.file !== undefined) {
    if (!RepoPath.safeParse(values.file).success) {
      throw new UsageError(`--file must be a repository-relative path, got ${values.file}`);
    }
    query = { file: values.file, side: values.side, lines: null };
    if (values.lines !== undefined) {
      const match = /^([1-9]\d*)-([1-9]\d*)$/.exec(values.lines);
      if (!match || Number(match[2]) < Number(match[1])) {
        throw new UsageError(`--lines must look like 10-40, got ${values.lines}`);
      }
      query.lines = { start: Number(match[1]), end: Number(match[2]) };
    }
  } else {
    query = { id: positionals[0]! };
  }

  const read = (name: string): unknown => JSON.parse(readFileSync(join(values.dir!, name), 'utf8'));
  const changeSet = ChangeSet.parse(read('changes.json'));
  const graph = ChangeGraph.parse(read('graph.json'));
  if (graph.snapshotId !== changeSet.snapshotId) {
    throw new Error(`graph.json and changes.json in ${values.dir} are from different snapshots`);
  }
  // Unchanged files come from Git at the snapshot's revision, so this must run in the repository;
  // elsewhere only changed files can be read.
  let files;
  try {
    files = gitSnapshotFiles(await gitLine(io.cwd, ['rev-parse', '--show-toplevel']), changeSet);
  } catch {
    files = changeSetFiles(changeSet);
  }
  try {
    io.out(await show(changeSet, graph, files, query));
  } catch (err) {
    if (!(err instanceof ShowError)) throw err;
    io.err(`${err.message}\n`);
    return EXIT.failed;
  }
  return EXIT.ok;
}

/** `a..b` (direct) or `a...b` (merge base), as Git spells them. An empty end is HEAD. */
export function parseRange(spec: string): Extract<ReviewTarget, { kind: 'range' }> {
  const match = /^(.*?)(\.\.\.?)(.*)$/.exec(spec);
  if (!match || (match[1] === '' && match[3] === '') || /\.\./.test(match[3]!)) {
    throw new UsageError(`--range must look like <base>..<head> or <base>...<head>, got ${spec}`);
  }
  return {
    kind: 'range',
    base: match[1] || 'HEAD',
    head: match[3] || 'HEAD',
    mode: match[2] === '...' ? 'merge-base' : 'direct',
  };
}

function positiveInt(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} must be a positive whole number, got ${value}`);
  }
  return Number(value);
}

function nonEmpty(flag: string, value: string): string {
  if (value === '') throw new UsageError(`${flag} needs a value`);
  return value;
}

function isParseArgsError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
