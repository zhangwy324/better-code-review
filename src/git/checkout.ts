// Writes a revision's files into a plain directory, for a language server on either side
// (src/cli/generate.ts, #66). The directory has no `.git`.
//
// The files go through a throwaway index (GIT_INDEX_FILE, as in local.ts): `read-tree` loads the
// revision and `checkout-index --prefix` writes it out, so the user's index, working tree and
// worktree list are never touched. Smudge filters and `core.autocrlf` apply, as for a checkout;
// Git LFS does not download objects. No hooks run, and submodules are not checked out.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './run.ts';

/** Writes the files of `revision` (a commit or tree) into `dir`, creating it. */
export async function checkoutRevision(repo: string, revision: string, dir: string): Promise<void> {
  const indexDir = mkdtempSync(join(tmpdir(), 'bcr-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(indexDir, 'index'), GIT_LFS_SKIP_SMUDGE: '1' };
    await runGit(repo, ['read-tree', revision], '', env);
    // `--prefix` is a string prefix, not a directory: it needs the trailing separator.
    await runGit(repo, ['checkout-index', '--all', `--prefix=${dir}/`], '', env);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}
