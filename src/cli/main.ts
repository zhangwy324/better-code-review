#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ReviewTarget } from '../schemas/index.ts';
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

Writes changes.json, graph.json and summary.txt for a Git change, with no AI involved.

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
