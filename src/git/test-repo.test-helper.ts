// Small deterministic repositories for tests: fixed identity and dates, no user or system config,
// and files written straight into the index, so any path works on any OS and no checkout is
// needed. Importing this registers an afterAll hook that deletes every repository it made.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bcr-home-'));
/** Hides user and system config and pins identities and dates. */
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  // A path that does not exist: Git reads it as an empty global config on every OS.
  GIT_CONFIG_GLOBAL: join(CONFIG_DIR, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
export const ENV = { ...process.env, ...ISOLATED_GIT_ENV };

export type FileSpec =
  string | Buffer | null | { mode: '100755' | '120000'; content: string | Buffer };

const repos: TestRepo[] = [];
afterAll(() => {
  for (const dir of [CONFIG_DIR, ...repos.map((r) => r.path)]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export class TestRepo {
  readonly path = mkdtempSync(join(tmpdir(), 'bcr-git-'));

  constructor() {
    repos.push(this);
    this.git('init', '-q', '-b', 'main');
    // Git for Windows rejects NTFS-invalid paths (quotes, tabs) even in the index; nothing is
    // checked out here, so the check only gets in the way.
    this.git('config', 'core.protectNTFS', 'false');
  }

  git(...args: string[]): string {
    return this.gitInput(undefined, ...args);
  }

  gitInput(input: string | Buffer | undefined, ...args: string[]): string {
    return execFileSync('git', args, { cwd: this.path, env: ENV, input, encoding: 'utf8' });
  }

  /** Stages `files` (null deletes) on top of `parents[0]`, commits and returns the commit ID. */
  commit(parents: string[], files: Record<string, FileSpec>): string {
    if (parents[0]) this.git('read-tree', parents[0]);
    else this.git('read-tree', '--empty');
    for (const [path, spec] of Object.entries(files)) {
      if (spec === null) {
        this.git('update-index', '--force-remove', '--', path);
        continue;
      }
      const { mode, content } =
        typeof spec === 'string' || Buffer.isBuffer(spec)
          ? { mode: '100644', content: spec }
          : spec;
      const oid = this.gitInput(content, 'hash-object', '-w', '--stdin').trim();
      this.git('update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`);
    }
    const tree = this.git('write-tree').trim();
    const parentArgs = parents.flatMap((p) => ['-p', p]);
    return this.git('commit-tree', tree, ...parentArgs, '-m', 'commit').trim();
  }
}
