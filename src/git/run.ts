// Runs the git CLI. Everything in src/git shells out to git rather than reading the object
// database itself, so the repository's own Git does the resolving and diffing. `runCommand` is
// the process plumbing, shared with the GitHub CLI runner (pr.ts).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Git could not be started because no `git` executable was found on PATH. */
export class GitNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('git was not found on PATH; better-code-review needs Git installed', options);
    this.name = 'GitNotFoundError';
  }
}

/**
 * Runs `git <args>` in `cwd` and resolves with its raw stdout. Rejects on a non-zero exit.
 * `env` is merged over the process environment.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: Record<string, string>,
): Promise<Buffer> {
  return (await runGitWithStderr(cwd, args, input, env)).stdout;
}

/** `runGit`, also resolving with what Git printed on stderr (warnings) when it succeeded. */
export function runGitWithStderr(
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: Record<string, string>,
): Promise<CommandOutput> {
  return runCommand('git', cwd, args, {
    input,
    env,
    notFound: (cause) => new GitNotFoundError({ cause }),
    failed: (exitCode, stderr) => new GitError(args, exitCode, stderr),
  });
}

export interface CommandOutput {
  stdout: Buffer;
  stderr: string;
}

export interface RunCommandOptions {
  input?: string | undefined;
  /** Merged over the process environment. */
  env?: Record<string, string> | undefined;
  /** The error for a missing executable. */
  notFound: (cause: Error) => Error;
  /** The error for a non-zero exit. */
  failed: (exitCode: number | null, stderr: string) => Error;
}

/** Runs `command <args>` in `cwd` and resolves with its raw stdout and stderr. Shared by git and gh. */
export function runCommand(
  command: string,
  cwd: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandOutput> {
  const { input, env, notFound, failed } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env && { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Node reports a missing executable and a missing cwd with the same ENOENT error.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') reject(err);
      else if (!existsSync(cwd)) reject(new Error(`Repository path does not exist: ${cwd}`));
      else reject(notFound(err));
    });
    child.on('close', (code) => {
      const errText = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: errText });
      else reject(failed(code, errText));
    });
    // If the command exits before reading its input, the failure is reported by the exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** `runGit`, decoded as UTF-8 with the trailing newline removed. */
export async function gitLine(
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: Record<string, string>,
): Promise<string> {
  return (await runGit(cwd, args, input, env)).toString('utf8').replace(/\n$/, '');
}
