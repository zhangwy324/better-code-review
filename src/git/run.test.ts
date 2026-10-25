import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitError,
  GitNotFoundError,
  OutputTooLargeError,
  resolveExecutable,
  runGit,
} from './run.ts';

describe('runGit', () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  it('reports a missing git executable', async () => {
    process.env.PATH = '';
    await expect(runGit(tmpdir(), ['--version'])).rejects.toBeInstanceOf(GitNotFoundError);
  });

  it('reports a missing repository path rather than a missing git', async () => {
    const missing = join(tmpdir(), 'bcr-does-not-exist');
    await expect(runGit(missing, ['--version'])).rejects.toThrow(
      `Repository path does not exist: ${missing}`,
    );
  });

  it('reports a non-zero exit as a GitError', async () => {
    await expect(runGit(tmpdir(), ['no-such-command'])).rejects.toBeInstanceOf(GitError);
  });

  it('stops a command whose output is over the cap', async () => {
    const version = await runGit(tmpdir(), ['--version']);
    await expect(runGit(tmpdir(), ['--version'], '', undefined, version.length)).resolves.toEqual(
      version,
    );
    await expect(
      runGit(tmpdir(), ['--version'], '', undefined, version.length - 1),
    ).rejects.toBeInstanceOf(OutputTooLargeError);
  });
});

describe('resolveExecutable', () => {
  it('on Windows, finds a bare name on PATH only, never in the working directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bcr-which-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git.exe'), '');
      // A relative entry stands for the repository, as libuv's working-directory lookup would.
      const path = ['.', 'repo', '', bin].join(delimiter);
      expect(resolveExecutable('git', 'win32', path)).toBe(join(bin, 'git.exe'));
      expect(resolveExecutable('gh', 'win32', path)).toBeNull();
      writeFileSync(join(bin, 'git.com'), '');
      expect(resolveExecutable('git', 'win32', path)).toBe(join(bin, 'git.com'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves other platforms, and names with a directory, to spawn', () => {
    expect(resolveExecutable('git', 'linux', '')).toBe('git');
    expect(resolveExecutable('C:\\Git\\git.exe', 'win32', '')).toBe('C:\\Git\\git.exe');
  });
});
