// Small deterministic repositories for tests: fixed identity and dates, no user or system config,
// and files written straight into the index (test/fixtures/repo.ts). Importing this registers an
// afterAll hook that deletes every repository it made.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { GitRepo, isolatedGitEnv } from '../../test/fixtures/repo.ts';

export type { FileSpec } from '../../test/fixtures/repo.ts';

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bcr-home-'));
/** Hides user and system config and pins identities and dates. */
export const ISOLATED_GIT_ENV = isolatedGitEnv(join(CONFIG_DIR, 'gitconfig'));
export const ENV = { ...process.env, ...ISOLATED_GIT_ENV };

const repos: TestRepo[] = [];
afterAll(() => {
  for (const dir of [CONFIG_DIR, ...repos.map((r) => r.path)]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export class TestRepo extends GitRepo {
  constructor() {
    super(mkdtempSync(join(tmpdir(), 'bcr-git-')), ENV);
    repos.push(this);
  }
}
