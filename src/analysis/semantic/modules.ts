// Installed dependencies for a revision written out by src/git/checkout.ts (#117). A checkout
// holds tracked files only, so without help a TypeScript server there cannot resolve the
// project's packages, every file with a package import is unhealthy, and nothing is rejected.
// When the working tree's `node_modules` is the user's own install (`checkProjectPackages`, D11),
// the checkout gets a link to it, as `--local` would see it. The packages may not match the
// revision; the health hint then says so.
import { existsSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GitError, runGit } from '../../git/run.ts';
import { checkProjectPackages } from './servers.ts';

/** How a checkout's `node_modules` was provided, for `LspOptions.modules`. */
export interface SnapshotModules {
  /**
   * The working tree whose `node_modules` the checkout's links to, or null when none was linked.
   * The session checks that one's packages (`checkProjectPackages`), not the checkout's link.
   */
  linkedFrom: string | null;
  /** Replaces the TypeScript health hint, or null to keep it. */
  healthHint: string | null;
}

/** Files that decide which packages are installed. A difference makes the link a guess. */
const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

/**
 * Links `<tree>/node_modules` to the working tree's, when that is the user's own install or
 * project code is allowed. `tree` holds `revision` of `repo`. Remove the link with
 * `unlinkInstalledModules` before deleting `tree`.
 */
export async function linkInstalledModules(
  repo: string,
  revision: string,
  tree: string,
  allowProjectCode: boolean,
): Promise<SnapshotModules> {
  const modules = join(repo, 'node_modules');
  // The revision tracks its own node_modules: the session passes it over (checked out from Git).
  if (existsSync(join(tree, 'node_modules'))) return { linkedFrom: null, healthHint: null };
  if (!existsSync(modules)) {
    return {
      linkedFrom: null,
      healthHint:
        "This revision's checkout has no installed dependencies, and the working tree has no node_modules to lend it. Install the project's dependencies in the working tree (e.g. `npm ci`) so imports resolve.",
    };
  }
  const untrusted = allowProjectCode ? null : checkProjectPackages(repo);
  if (untrusted !== null) {
    return {
      linkedFrom: null,
      healthHint: `This revision's checkout has no installed dependencies: the working tree's node_modules was not lent to it, because ${untrusted} (needs the project-code opt-in). Installing dependencies would not change this.`,
    };
  }
  const differ = await manifestsDiffer(repo, revision);
  // A junction on Windows, which needs no privilege; other platforms ignore the type. Made last,
  // so a failure above leaves no link to remove.
  symlinkSync(realpathSync(modules), join(tree, 'node_modules'), 'junction');
  return {
    linkedFrom: repo,
    healthHint: differ
      ? "The server uses the working tree's node_modules, but this revision's package.json or lockfile differs from the working tree's, so the installed packages may not match it."
      : null,
  };
}

/** Removes the link `linkInstalledModules` made, never what it points to. */
export function unlinkInstalledModules(tree: string, modules: SnapshotModules): void {
  if (modules.linkedFrom !== null) unlinkSync(join(tree, 'node_modules'));
}

/** Whether a manifest differs between `revision` and the working tree. */
async function manifestsDiffer(repo: string, revision: string): Promise<boolean> {
  try {
    await runGit(repo, ['diff', '--quiet', revision, '--', ...MANIFESTS]);
    return false;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return true;
    throw err;
  }
}
