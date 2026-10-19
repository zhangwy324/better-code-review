import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { extractChangeSet } from './extract.ts';
import { GhError, GhNotFoundError, type GhRunner, repositoryKey, runGh } from './pr.ts';
import { ISOLATED_GIT_ENV, TestRepo } from './test-repo.test-helper.ts';

// The extractor's own git calls (the fetch) run with the process environment, so the isolated
// config is applied to it as well. gh is never run: each test passes a fake that answers the
// `gh api` call with a canned GitHub response.
const saved = Object.fromEntries(Object.keys(ISOLATED_GIT_ENV).map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, ISOLATED_GIT_ENV));
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REPO_URL = 'https://github.com/acme/widgets';

/** The fields of GitHub's "get a pull request" response that the extractor reads. */
function pullResponse(base: string, head: string, body: string | null = 'Adds **bold**.\n') {
  return {
    html_url: `${REPO_URL}/pull/7`,
    title: 'Add the feature',
    body,
    base: { ref: 'main', sha: base, repo: { full_name: 'acme/widgets', html_url: REPO_URL } },
    head: { ref: 'feature', sha: head },
  };
}

function fakeGh(response: unknown) {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  const gh: GhRunner = (cwd, args) => {
    calls.push({ cwd, args });
    return Promise.resolve(JSON.stringify(response));
  };
  return { gh, calls };
}

function failingGh(exitCode: number, stderr: string): GhRunner {
  return (_cwd, args) => Promise.reject(new GhError(args, exitCode, stderr));
}

/** main and feature fork from one commit; feature is then merged, as on a merged PR. */
function buildPullRepo() {
  const repo = new TestRepo();
  const fork = repo.commit([], { 'shared.txt': 'v1\n', 'main.txt': 'm1\n' });
  const base = repo.commit([fork], { 'main.txt': 'm2\n' });
  const head = repo.commit([fork], { 'shared.txt': 'v2\n', 'new.txt': 'new\n' });
  const merge = repo.commit([base, head], { 'shared.txt': 'v2\n', 'new.txt': 'new\n' });
  repo.git('update-ref', 'refs/heads/main', merge);
  repo.git('update-ref', 'refs/pull/7/head', head);
  return { repo, fork, base, head };
}

describe('extractChangeSet: pr target', () => {
  const { repo, fork, base, head } = buildPullRepo();

  it("diffs merge-base(base, head)..head, GitHub's Files changed", async () => {
    const { gh, calls } = fakeGh(pullResponse(base, head));
    const changes = await extractChangeSet(repo.path, { kind: 'pr', number: 7 }, { gh });

    expect(calls).toEqual([{ cwd: repo.path, args: ['api', 'repos/{owner}/{repo}/pulls/7'] }]);
    expect(changes.target).toEqual({ kind: 'pr', number: 7 });
    expect([changes.baseRevision, changes.headRevision]).toEqual([fork, head]);
    // main.txt changed on the base side only, so it is not part of the PR.
    expect(changes.files.map((f) => [f.status, f.newPath])).toEqual([
      ['added', 'new.txt'],
      ['modified', 'shared.txt'],
    ]);
    expect(changes.pullRequest).toEqual({
      url: `${REPO_URL}/pull/7`,
      title: 'Add the feature',
      description: 'Adds **bold**.\n',
      baseRefName: 'main',
      headRefName: 'feature',
    });

    // The same diff as the equivalent range, so the same snapshot.
    const range = await extractChangeSet(repo.path, {
      kind: 'range',
      base,
      head,
      mode: 'merge-base',
    });
    expect(changes.snapshotId).toBe(range.snapshotId);
    expect(changes.files).toEqual(range.files);
    expect(range.pullRequest).toBeNull();
  });

  it('uses the base commit GitHub records, not the base branch tip, once merged', async () => {
    // main now contains the head, so main...head is empty; the PR still shows its diff.
    const merged = await extractChangeSet(repo.path, {
      kind: 'range',
      base: 'main',
      head,
      mode: 'merge-base',
    });
    expect(merged.files).toEqual([]);

    const { gh } = fakeGh(pullResponse(base, head));
    const changes = await extractChangeSet(repo.path, { kind: 'pr', number: 7 }, { gh });
    expect(changes.files).toHaveLength(2);
  });

  it('reads a missing description as empty', async () => {
    const { gh } = fakeGh(pullResponse(base, head, null));
    const changes = await extractChangeSet(repo.path, { kind: 'pr', number: 7 }, { gh });
    expect(changes.pullRequest?.description).toBe('');
  });

  it("fetches missing commits from the base repository's remote, writing no refs", async () => {
    // As GitHub does, the "server" serves any commit reachable from its refs by ID.
    repo.git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
    const clone = new TestRepo();
    clone.git('remote', 'add', 'fork', 'git@github.com:someone/widgets.git');
    clone.git('remote', 'add', 'up.stream', `${REPO_URL}.git`);
    clone.git('config', `url.${pathToFileURL(repo.path).href}.insteadOf`, `${REPO_URL}.git`);

    const { gh } = fakeGh(pullResponse(base, head));
    const changes = await extractChangeSet(clone.path, { kind: 'pr', number: 7 }, { gh });
    expect([changes.baseRevision, changes.headRevision]).toEqual([fork, head]);
    expect(changes.files.map((f) => f.newPath)).toEqual(['new.txt', 'shared.txt']);
    expect(clone.git('for-each-ref')).toBe('');
    expect(existsSync(join(clone.path, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('says how to fix a missing remote or a failed fetch', async () => {
    const { gh } = fakeGh(pullResponse(base, head));
    const clone = new TestRepo();
    await expect(extractChangeSet(clone.path, { kind: 'pr', number: 7 }, { gh })).rejects.toThrow(
      /no git remote points at acme\/widgets/,
    );

    clone.git('remote', 'add', 'origin', `${REPO_URL}.git`);
    const missing = pathToFileURL(join(tmpdir(), 'bcr-no-such-remote')).href;
    clone.git('config', `url.${missing}.insteadOf`, `${REPO_URL}.git`);
    await expect(extractChangeSet(clone.path, { kind: 'pr', number: 7 }, { gh })).rejects.toThrow(
      /Could not fetch the pull request's commits from remote origin/,
    );
  });

  it('explains gh failures', async () => {
    const extract = (gh: GhRunner) =>
      extractChangeSet(repo.path, { kind: 'pr', number: 7 }, { gh });
    const login = /not authenticated.*gh auth login/;
    await expect(
      extract(failingGh(4, 'To get started with GitHub CLI, please run:  gh auth login\n')),
    ).rejects.toThrow(login);
    await expect(extract(failingGh(1, 'gh: Bad credentials (HTTP 401)\n'))).rejects.toThrow(login);
    await expect(extract(failingGh(1, 'gh: Not Found (HTTP 404)\n'))).rejects.toThrow(
      /Pull request #7 was not found/,
    );
    await expect(
      extract(failingGh(1, 'unable to expand placeholder in path: no git remotes found\n')),
    ).rejects.toThrow(/gh could not find the GitHub repository for .*: no git remotes found$/);
    await expect(extract(failingGh(1, 'gh: Server Error (HTTP 502)\n'))).rejects.toBeInstanceOf(
      GhError,
    );
    await expect(extract(() => Promise.resolve('{"message":"odd"}'))).rejects.toThrow();
  });
});

describe('runGh', () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  it('reports a missing gh executable', async () => {
    process.env.PATH = '';
    await expect(runGh(tmpdir(), ['--version'])).rejects.toBeInstanceOf(GhNotFoundError);
  });
});

describe('repositoryKey', () => {
  it('reads every URL form of a GitHub remote', () => {
    for (const url of [
      'https://github.com/Acme/Widgets',
      'https://github.com/acme/widgets.git',
      'https://user:token@github.com/acme/widgets/',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets',
      'ssh://git@github.com:22/acme/widgets.git',
    ]) {
      expect(repositoryKey(url), url).toBe('github.com/acme/widgets');
    }
    expect(repositoryKey('/srv/git/widgets')).toBeNull();
  });
});
