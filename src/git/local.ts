// Captures the working tree for the `local` target (#11, design reference §4.4, §19.4 Q6) as a
// Git tree object, so the rest of the extractor diffs two immutable trees exactly as it does for
// commits.
//
// Overlay semantics: the review compares HEAD with the files as they are on disk.
// - Tracked files (every path in the index, staged or not) are taken from the working tree, so
//   staged and unstaged edits are reviewed together and an unstaged edit wins over a staged one.
//   This is `git diff HEAD`. A file deleted from disk is deleted, whether or not it is staged.
// - Untracked files that .gitignore and the other exclude files don't ignore are added when
//   `includeUntracked` is set. Otherwise they are listed as excluded, never dropped silently.
// - Files tracked despite matching .gitignore stay tracked, as Git treats them.
// - Clean filters and `core.autocrlf` apply, as they do for `git diff` and `git add`.
//
// The capture stages everything into a throwaway copy of the index (GIT_INDEX_FILE), so the
// user's index is never touched. Git does write the blobs into the object database as loose
// objects; `git gc` prunes them later.
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitError, gitLine, runGit } from './run.ts';

/** Covers coarse file timestamps (2 s on FAT) as well as float rounding of the mtime. */
const RACY_MARGIN_SECONDS = 2;

export interface WorkingTreeSnapshot {
  /** The HEAD commit, or null on an unborn branch (no commits yet). */
  head: string | null;
  /** The tree object holding the captured working tree. */
  tree: string;
  /** Untracked, non-ignored paths left out because untracked files were not requested. */
  excludedUntracked: string[];
}

/** Reads the working tree of the repository at `repo` into a tree object. */
export async function captureWorkingTree(
  repo: string,
  includeUntracked: boolean,
): Promise<WorkingTreeSnapshot> {
  if ((await gitLine(repo, ['rev-parse', '--is-bare-repository'])) === 'true') {
    throw new Error(`${repo} is a bare repository and has no working tree to review`);
  }
  const top = await gitLine(repo, ['rev-parse', '--show-toplevel']);
  const head = await resolveHead(top);

  const dir = mkdtempSync(join(tmpdir(), 'bcr-index-'));
  try {
    // Starting from the real index keeps Git's notion of which files are tracked, and its stat
    // data means only files that changed on disk are hashed again. Git trusts that stat data
    // only for entries older than the index file itself ("racy git"), so the copy is backdated:
    // with a fresh mtime, a same-size edit made in the same timestamp tick as the last
    // `git add` would look clean and the staged version would be reviewed instead.
    const indexFile = join(dir, 'index');
    const realIndex = resolve(top, await gitLine(top, ['rev-parse', '--git-path', 'index']));
    if (existsSync(realIndex)) {
      copyFileSync(realIndex, indexFile);
      const backdated = statSync(realIndex).mtimeMs / 1000 - RACY_MARGIN_SECONDS;
      utimesSync(indexFile, backdated, backdated);
    }
    const env = { GIT_INDEX_FILE: indexFile };

    await runGit(top, ['add', includeUntracked ? '--all' : '--update', '--', ':/'], '', env);
    const tree = await gitLine(top, ['write-tree'], '', env);
    const untracked = ['ls-files', '--others', '--exclude-standard', '-z', '--', ':/'];
    const excludedUntracked = includeUntracked
      ? []
      : (await runGit(top, untracked, '', env))
          .toString('utf8')
          .split('\0')
          .filter(Boolean)
          .sort(comparePaths);
    return { head, tree, excludedUntracked };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Raised when the working tree, the HEAD commit or the set of untracked files changed while the
 * snapshot was being taken, so the snapshot might mix files from before and after the change.
 */
export class SnapshotChangedError extends Error {
  constructor(changed: readonly string[]) {
    super(
      `The working tree changed while it was being captured (${changed.join(', ')}). ` +
        'Wait for edits to finish and try again.',
    );
    this.name = 'SnapshotChangedError';
  }
}

/** Throws SnapshotChangedError unless two captures of the same working tree agree. */
export function assertSameSnapshot(before: WorkingTreeSnapshot, after: WorkingTreeSnapshot) {
  const changed = [
    before.head !== after.head && 'HEAD moved',
    before.tree !== after.tree && 'file contents',
    before.excludedUntracked.join('\0') !== after.excludedUntracked.join('\0') && 'untracked files',
  ].filter((c) => c !== false);
  if (changed.length > 0) throw new SnapshotChangedError(changed);
}

async function resolveHead(repo: string): Promise<string | null> {
  return gitLine(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(
    (err: unknown) => {
      // Exit code 1 with nothing on stderr means HEAD names a branch with no commits yet.
      if (err instanceof GitError && err.exitCode === 1 && err.stderr === '') return null;
      throw err;
    },
  );
}

/** Git's order: plain byte order of the UTF-8 paths. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
