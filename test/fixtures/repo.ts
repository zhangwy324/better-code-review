// Deterministic Git repositories built from file maps, with no test runner involved, so both the
// tests (src/git/test-repo.test-helper.ts) and `npm run fixtures` can use them. Files are written
// straight into the index, so any path works on any OS and no checkout is needed.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Fixture } from './fixture.ts';

/** Hides user and system config and pins identities and dates. */
export function isolatedGitEnv(globalConfig: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    // A path that does not exist: Git reads it as an empty global config on every OS.
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Fixture Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.com',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
}

/**
 * Every fixture git call is plumbing on a tiny repository: none took 0.1s on Linux with the whole
 * suite running. This leaves ample room for a slow Windows runner.
 */
const GIT_TIMEOUT_MS = 60_000;

export type FileSpec =
  string | Buffer | null | { mode: '100755' | '120000'; content: string | Buffer };

export class GitRepo {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(path: string, env: NodeJS.ProcessEnv) {
    this.path = path;
    this.env = env;
    this.git('init', '-q', '-b', 'main');
    // Git for Windows rejects NTFS-invalid paths (quotes, tabs) even in the index; nothing is
    // checked out here, so the check only gets in the way.
    this.git('config', 'core.protectNTFS', 'false');
  }

  git(...args: string[]): string {
    return this.gitInput(undefined, ...args);
  }

  gitInput(input: string | Buffer | undefined, ...args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd: this.path,
        env: this.env,
        input,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (err) {
      // A synchronous call blocks the test runner's own timeouts, so a stuck git would hang the
      // whole run (#131). Name the command instead.
      if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(
          `git ${args.join(' ')} in ${this.path} took over ${GIT_TIMEOUT_MS / 1000}s`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /** Stages `files` (null deletes) on top of `parents[0]`, commits and returns the commit ID. */
  commit(parents: string[], files: Record<string, FileSpec>, message = 'commit'): string {
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
    return this.git('commit-tree', tree, ...parentArgs, '-m', message).trim();
  }
}

export interface FixtureRepo {
  repo: GitRepo;
  base: string;
  head: string;
}

/**
 * Builds `fixture` as a repository in `dir` (created if missing; it must not already be one):
 * `base`, then `head` on top. `main` points at `head` and the tag `base` at `base`, so the change
 * is `--commit main` or `--range base..main`. With `checkout`, the working tree holds `head`.
 */
export function buildFixtureRepo(
  dir: string,
  fixture: Fixture,
  { checkout = false, env = process.env }: { checkout?: boolean; env?: NodeJS.ProcessEnv } = {},
): FixtureRepo {
  mkdirSync(dir, { recursive: true });
  const repo = new GitRepo(dir, {
    ...env,
    ...isolatedGitEnv(join(dir, '.git', 'no-global-config')),
  });
  // Checked-out files keep the fixture's line endings, whatever Git for Windows would do.
  repo.git('config', 'core.autocrlf', 'false');
  const base = repo.commit([], fixture.base, `${fixture.name}: base`);
  const head = repo.commit([base], fixture.head, `${fixture.name}: head`);
  repo.git('update-ref', 'refs/heads/main', head);
  repo.git('tag', 'base', base);
  if (checkout) repo.git('reset', '-q', '--hard', 'main');
  return { repo, base, head };
}
