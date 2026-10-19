// Resolves a `pr` target (#12, design reference §4.4, §8.1) through the GitHub CLI: the PR's base
// and head commits, fetched if they are missing locally, and its title and description for the
// planner. The extractor then diffs merge-base(base, head)..head, which is GitHub's "Files
// changed" (a three-dot diff).
//
// `gh api` is used rather than `gh pr view` because older gh releases (e.g. 2.45, still current in
// Ubuntu 24.04) have no `baseRefOid` field. Its `{owner}/{repo}` placeholders make gh pick the
// repository exactly as `gh pr view` would: from the git remotes, `gh repo set-default` or GH_REPO.
//
// The base commit is the one GitHub records on the PR, not the current tip of the base branch.
// For an open PR the two have the same merge base with the head; for a merged PR the branch tip
// already contains the head, and only the recorded commit gives the diff GitHub still shows.
import { z } from 'zod';
import type { PullRequestInfo } from '../schemas/index.ts';
import { GitError, gitLine, runCommand, runGit } from './run.ts';

/** Runs `gh <args>` in `cwd` and resolves with its stdout. Injectable so tests need no gh. */
export type GhRunner = (cwd: string, args: readonly string[]) => Promise<string>;

export class GhError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`gh ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GhError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** The GitHub CLI could not be started because no `gh` executable was found on PATH. */
export class GhNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'gh (the GitHub CLI) was not found on PATH; reviewing a pull request needs it. ' +
        'Install it from https://cli.github.com and run `gh auth login`.',
      options,
    );
    this.name = 'GhNotFoundError';
  }
}

export const runGh: GhRunner = async (cwd, args) =>
  (
    await runCommand('gh', cwd, args, {
      notFound: (cause) => new GhNotFoundError({ cause }),
      failed: (exitCode, stderr) => new GhError(args, exitCode, stderr),
    })
  ).toString('utf8');

/** The fields of GitHub's "get a pull request" response that are used here. */
const PullResponse = z.object({
  html_url: z.string().min(1),
  title: z.string(),
  body: z.string().nullable(),
  base: z.object({
    ref: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    repo: z.object({ full_name: z.string().min(1), html_url: z.string().min(1) }),
  }),
  head: z.object({ ref: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
});

export interface ResolvedPullRequest {
  /** The base commit GitHub records on the PR. The diff starts at its merge base with `head`. */
  base: string;
  head: string;
  info: PullRequestInfo;
}

/** Looks up PR `number` with gh and makes sure its base and head commits are present locally. */
export async function resolvePullRequest(
  repo: string,
  number: number,
  gh: GhRunner = runGh,
): Promise<ResolvedPullRequest> {
  const out = await gh(repo, ['api', `repos/{owner}/{repo}/pulls/${number}`]).catch(
    (err: unknown) => {
      throw err instanceof GhError ? explainGhError(repo, number, err) : err;
    },
  );
  const pr = PullResponse.parse(JSON.parse(out));

  const missing: string[] = [];
  for (const oid of [pr.base.sha, pr.head.sha]) {
    if (!(await hasCommit(repo, oid))) missing.push(oid);
  }
  if (missing.length > 0) await fetchCommits(repo, pr.base.repo, missing);

  return {
    base: pr.base.sha,
    head: pr.head.sha,
    info: {
      url: pr.html_url,
      title: pr.title,
      description: pr.body ?? '',
      baseRefName: pr.base.ref,
      headRefName: pr.head.ref,
    },
  };
}

/** Turns the gh failures a user can fix into errors that say how. */
function explainGhError(repo: string, number: number, err: GhError): Error {
  // gh exits with 4 when it has no credentials at all; a rejected token is an HTTP 401.
  if (err.exitCode === 4 || /\(HTTP 401\)/.test(err.stderr)) {
    return new Error(
      'gh is not authenticated with GitHub. Run `gh auth login` (or set GH_TOKEN) and try again.',
      { cause: err },
    );
  }
  if (/\(HTTP 404\)/.test(err.stderr)) {
    return new Error(
      `Pull request #${number} was not found in the GitHub repository of ${repo}. ` +
        'The number may be an issue, or gh may have no access to the repository.',
      { cause: err },
    );
  }
  // gh could not tell which GitHub repository the working directory belongs to.
  const placeholder = /unable to expand placeholder in path: (.*)/.exec(err.stderr);
  if (placeholder) {
    return new Error(
      `gh could not find the GitHub repository for ${repo}: ${placeholder[1]?.trim()}`,
      { cause: err },
    );
  }
  return err;
}

async function hasCommit(repo: string, oid: string): Promise<boolean> {
  return gitLine(repo, ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`]).then(
    () => true,
    (err: unknown) => {
      if (err instanceof GitError && err.exitCode === 1) return false;
      throw err;
    },
  );
}

/**
 * Fetches commits by ID from the remote that points at the PR's base repository. GitHub serves any
 * commit reachable from its refs, and a PR's head is kept under `refs/pull/<n>/head` there, so this
 * also covers PRs from forks and from deleted branches. No ref is written (not even FETCH_HEAD):
 * the objects are only needed for this run.
 */
async function fetchCommits(
  repo: string,
  baseRepo: { full_name: string; html_url: string },
  oids: string[],
): Promise<void> {
  const remote = await findRemote(repo, baseRepo.html_url);
  if (remote === null) {
    throw new Error(
      `The pull request's commits are not in ${repo}, and no git remote points at ` +
        `${baseRepo.full_name} to fetch them from. Add one (e.g. \`git remote add upstream ` +
        `${baseRepo.html_url}\`) or fetch them yourself, then try again.`,
    );
  }
  const fetch = ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, ...oids];
  await runGit(repo, fetch).catch((err: unknown) => {
    if (!(err instanceof GitError)) throw err;
    throw new Error(
      `Could not fetch the pull request's commits from remote ${remote}: ${err.stderr.trim()}`,
      { cause: err },
    );
  });
}

/** The name of the first remote whose URL is `htmlUrl`'s repository, in any URL form. */
async function findRemote(repo: string, htmlUrl: string): Promise<string | null> {
  const want = repositoryKey(htmlUrl);
  if (want === null) return null;
  const lines = await gitLine(repo, ['config', '--get-regexp', '^remote\\..*\\.url$']).then(
    (out) => out.split('\n'),
    (err: unknown) => {
      // Exit code 1 means no remote has a URL.
      if (err instanceof GitError && err.exitCode === 1) return [];
      throw err;
    },
  );
  for (const line of lines) {
    // `remote.<name>.url <url>`; a remote name may itself contain dots.
    const [key = '', url = ''] = line.split(/ (.*)/);
    if (repositoryKey(url) === want) return key.slice('remote.'.length, -'.url'.length);
  }
  return null;
}

/**
 * `host/owner/repo`, lowercased, for the URL forms a GitHub remote takes: `https://host/o/r`,
 * `ssh://git@host[:port]/o/r` and `git@host:o/r`, each with or without `.git`.
 */
export function repositoryKey(url: string): string | null {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/*$/i.exec(
      url.trim(),
    );
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
