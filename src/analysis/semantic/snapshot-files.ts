// Read access to the whole snapshot, not just the changed files (#17). Candidate search stays
// inside changed entities (D12), but deciding what a name refers to needs unchanged files too:
// the module an import names, a re-export file in between, and how many definitions a name has.
//
// Changed files come from the ChangeSet, so both sides are exactly what is reviewed. A file the
// change does not touch is the same on both sides, so it is read from one revision: the head
// commit, or for a `local` target the base (HEAD), which the working tree only differs from in
// changed files.
import type { ChangeSet, FileChange } from '../../schemas/changeset.ts';
import type { Side } from '../../schemas/common.ts';
import { GitError, runGit } from '../../git/run.ts';

export interface SnapshotFiles {
  /** A file's content on one side, or null when it does not exist there or is not text. */
  read(side: Side, path: string): Promise<string | null>;
  /**
   * The paths on one side whose content contains `word` as a whole word, or null when the
   * snapshot cannot be searched (then no name counts as having a single definition).
   */
  grep(side: Side, word: string): Promise<string[] | null>;
}

/** The changed files only: no unchanged file can be read, and nothing can be searched. */
export function changeSetFiles(changeSet: ChangeSet): SnapshotFiles {
  const changed = changedContent(changeSet);
  return {
    read: (side, path) => Promise.resolve(changed[side].get(path) ?? null),
    grep: () => Promise.resolve(null),
  };
}

/** The snapshot of `changeSet`, with unchanged files read from the repository at `repo`. */
export function gitSnapshotFiles(repo: string, changeSet: ChangeSet): SnapshotFiles {
  const changed = changedContent(changeSet);
  const revision = changeSet.headRevision ?? changeSet.baseRevision;
  const cache = new Map<string, Promise<string | null>>();

  const readUnchanged = (path: string): Promise<string | null> => {
    let content = cache.get(path);
    if (content === undefined) {
      content =
        revision === null
          ? Promise.resolve(null)
          : runGit(repo, ['cat-file', 'blob', `${revision}:${path}`]).then(
              (out) => (out.includes(0) ? null : out.toString('utf8')),
              () => null,
            );
      cache.set(path, content);
    }
    return content;
  };

  return {
    read: (side, path) => {
      const own = changed[side];
      if (own.has(path)) return Promise.resolve(own.get(path) ?? null);
      // A path the change adds, deletes or renames exists only on the other side.
      if (changed[side === 'old' ? 'new' : 'old'].has(path)) return Promise.resolve(null);
      return readUnchanged(path);
    },
    grep: async (side, word) => {
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`);
      const paths = new Set<string>();
      if (revision !== null) {
        let out: Buffer;
        try {
          out = await runGit(repo, ['grep', '-l', '-z', '-I', '-w', '-F', '-e', word, revision]);
        } catch (err) {
          // Exit 1 is "no match"; anything else means the snapshot cannot be searched.
          if (!(err instanceof GitError && err.exitCode === 1)) return null;
          out = Buffer.alloc(0);
        }
        const prefix = `${revision}:`;
        for (const entry of out.toString('utf8').split('\0')) {
          const path = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
          if (path && !changed.old.has(path) && !changed.new.has(path)) paths.add(path);
        }
      }
      for (const [path, content] of changed[side]) {
        if (content !== null && pattern.test(content)) paths.add(path);
      }
      return [...paths].sort();
    },
  };
}

/** Each side's changed paths, with their content (null when omitted or binary). */
function changedContent(changeSet: ChangeSet): Record<Side, Map<string, string | null>> {
  const old = new Map<string, string | null>();
  const neu = new Map<string, string | null>();
  for (const file of changeSet.files) {
    if (file.oldPath !== null) old.set(file.oldPath, textOf(file, file.oldContent));
    if (file.newPath !== null) neu.set(file.newPath, textOf(file, file.newContent));
  }
  return { old, new: neu };
}

function textOf(file: FileChange, content: string | null): string | null {
  return file.binary ? null : content;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
