// Runs the git CLI. Everything in src/git shells out to git rather than reading the object
// database itself, so the repository's own Git does the resolving and diffing. `runCommand` is
// the process plumbing, shared with the GitHub CLI runner (pr.ts).
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

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

/** A command printed more than `maxOutputBytes` on stdout, and was stopped. */
export class OutputTooLargeError extends Error {
  readonly maxOutputBytes: number;

  constructor(command: string, args: readonly string[], maxOutputBytes: number) {
    super(`${command} ${args.join(' ')} printed more than ${maxOutputBytes} bytes`);
    this.name = 'OutputTooLargeError';
    this.maxOutputBytes = maxOutputBytes;
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
  maxOutputBytes?: number,
): Promise<Buffer> {
  return (await runGitWithStderr(cwd, args, input, env, maxOutputBytes)).stdout;
}

/** `runGit`, also resolving with what Git printed on stderr (warnings) when it succeeded. */
export function runGitWithStderr(
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: Record<string, string>,
  maxOutputBytes?: number,
): Promise<CommandOutput> {
  return runCommand('git', cwd, args, {
    input,
    env,
    maxOutputBytes,
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
  /**
   * Stops the command and rejects with OutputTooLargeError once stdout is over this, so a huge
   * repository file or diff cannot exhaust memory (design reference §14.2). No limit by default.
   */
  maxOutputBytes?: number | undefined;
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
  const { input, env, maxOutputBytes = Infinity, notFound, failed } = options;
  const file = resolveExecutable(command);
  if (file === null) return Promise.reject(notFound(new Error(`${command} is not on PATH`)));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env && { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size <= maxOutputBytes) {
        stdout.push(chunk);
      } else {
        tooLarge = true;
        stdout.length = 0;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // Node reports a missing executable and a missing cwd with the same ENOENT error.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') reject(err);
      else if (!existsSync(cwd)) reject(new Error(`Repository path does not exist: ${cwd}`));
      else reject(notFound(err));
    });
    child.on('close', (code) => {
      if (tooLarge) return reject(new OutputTooLargeError(command, args, maxOutputBytes));
      const errText = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: errText });
      else reject(failed(code, errText));
    });
    // If the command exits before reading its input, the failure is reported by the exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * The file to run for `command`. On Windows, Node (libuv) looks a bare name up in the working
 * directory before `PATH`, and we run Git in the repository under review, so a `git.exe` the
 * change adds would run (#35, design reference §14.2). There a bare name is found on `PATH`'s
 * absolute entries instead, trying `.com` then `.exe` as libuv does, and null means not found.
 * Elsewhere, and for a name with a directory, it is `command` itself.
 */
export function resolveExecutable(
  command: string,
  platform: NodeJS.Platform = process.platform,
  searchPath: string = process.env.PATH ?? '',
): string | null {
  if (platform !== 'win32' || /[\\/]/.test(command)) return command;
  const names = extname(command) ? [command] : [`${command}.com`, `${command}.exe`];
  for (const dir of searchPath.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return null;
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
