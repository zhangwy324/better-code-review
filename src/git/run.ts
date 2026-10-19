// Runs the git CLI. Everything in src/git shells out to git rather than reading the object
// database itself, so the repository's own Git does the resolving and diffing.
import { spawn } from 'node:child_process';

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

/** Runs `git <args>` in `cwd` and resolves with its raw stdout. Rejects on a non-zero exit. */
export function runGit(cwd: string, args: readonly string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new GitError(args, code, Buffer.concat(stderr).toString('utf8')));
    });
    // If git exits before reading its input, the failure is reported by the exit code.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** `runGit`, decoded as UTF-8 with the trailing newline removed. */
export async function gitLine(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return (await runGit(cwd, args, input)).toString('utf8').replace(/\n$/, '');
}
