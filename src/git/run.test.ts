import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, GitNotFoundError, runGit } from './run.ts';

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
});
