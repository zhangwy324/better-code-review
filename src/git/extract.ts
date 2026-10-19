// Git extractor for `commit` and `range` targets (#10, design reference §8.2, §4.4): resolves the
// base and head commits, diffs them, and produces the ChangeSet written to changes.json.
//
// Out of scope here and owned by #13: rename and copy detection (renames show as a delete plus an
// add), the content size cap, non-UTF-8 text, and richer handling of type changes and
// submodules. Those cases must not crash or lose hunks, and the tests check that they don't.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHANGESET_SCHEMA_VERSION,
  ChangeSet,
  type FileChange,
  GITLINK_MODE,
  type ReviewTarget,
  stableId,
} from '../schemas/index.ts';
import { type PatchSection, parsePatch } from './patch.ts';
import { GitError, gitLine, runGit } from './run.ts';

export type RevisionTarget = Extract<ReviewTarget, { kind: 'commit' | 'range' }>;

export interface ResolvedRevisions {
  /** Null when the base is the empty tree (the commit has no parent). */
  base: string | null;
  head: string;
}

/**
 * Pins every diff option that user or repository config could otherwise change, so the hunks
 * (and so the hunk IDs) depend only on the two commits. Changing these changes hunks: bump
 * SNAPSHOT_FORMAT with them.
 */
const DIFF_CONFIG = ['-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true'];
const DIFF_OPTIONS = [
  '--no-renames',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--ignore-submodules=none',
  '--full-index',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--unified=3',
  '--inter-hunk-context=0',
  '--diff-algorithm=myers',
  '--indent-heuristic',
];
const SNAPSHOT_FORMAT = 'git-revisions/1';

/** Resolves a target to the two commits it compares. */
export async function resolveRevisions(
  repo: string,
  target: RevisionTarget,
): Promise<ResolvedRevisions> {
  if (target.kind === 'commit') {
    const head = await resolveCommit(repo, target.commit);
    const parentNumber = target.parent ?? 1;
    const parents = (await gitLine(repo, ['rev-list', '--parents', '-n', '1', head]))
      .split(' ')
      .slice(1);
    if (parents.length === 0) {
      if (await isShallowBoundary(repo, head)) {
        throw new Error(
          `Commit ${head} is at the boundary of a shallow clone, so its parent is missing. ` +
            'Fetch more history (e.g. `git fetch --deepen=1`) and try again.',
        );
      }
      if (parentNumber !== 1) throw new Error(`Commit ${head} is a root commit and has no parents`);
      return { base: null, head };
    }
    const base = parents[parentNumber - 1];
    if (base === undefined) {
      throw new Error(
        `Commit ${head} has ${parents.length} parent(s); parent ${parentNumber} does not exist`,
      );
    }
    return { base, head };
  }

  const base = await resolveCommit(repo, target.base);
  const head = await resolveCommit(repo, target.head);
  if (target.mode === 'direct') return { base, head };

  // merge-base mode is `git diff base...head`. With several merge bases (criss-cross merges)
  // Git would pick one arbitrarily; ask the user to choose rather than guess.
  const mergeBases = await runGit(repo, ['merge-base', '--all', base, head]).then(
    (out) => out.toString('utf8').split('\n').filter(Boolean),
    (err: unknown) => {
      // Exit code 1 with nothing on stderr means "no common ancestor".
      if (err instanceof GitError && err.exitCode === 1 && err.stderr === '') return [];
      throw err;
    },
  );
  if (mergeBases.length === 0) {
    const shallow = (await gitLine(repo, ['rev-parse', '--is-shallow-repository'])) === 'true';
    throw new Error(
      `${target.base} and ${target.head} have no common ancestor` +
        (shallow ? ' in this shallow clone; fetch more history and try again' : ''),
    );
  }
  if (mergeBases.length > 1) {
    throw new Error(
      `${target.base} and ${target.head} have ${mergeBases.length} merge bases ` +
        `(${mergeBases.join(', ')}); use a direct range from the one you want`,
    );
  }
  return { base: mergeBases[0] ?? null, head };
}

/** Extracts the ChangeSet for a `commit` or `range` target in the repository at `repo`. */
export async function extractChangeSet(repo: string, target: RevisionTarget): Promise<ChangeSet> {
  const { base, head } = await resolveRevisions(repo, target);
  const baseTree = base ?? (await gitLine(repo, ['hash-object', '-t', 'tree', '--stdin'], ''));
  const range = [baseTree, head];

  // One diff prints both the file list (`--raw`, NUL-separated) and the patch, so the two
  // always describe the same comparison. An empty NUL field separates them.
  const out = await runGit(repo, [
    ...DIFF_CONFIG,
    'diff',
    '--raw',
    '--patch',
    '-z',
    '--no-abbrev',
    ...DIFF_OPTIONS,
    ...range,
  ]);
  const separator = out.indexOf('\0\0');
  const raw = separator === -1 ? '' : out.subarray(0, separator + 1).toString('utf8');
  const patch = separator === -1 ? '' : out.subarray(separator + 2).toString('utf8');
  if (separator === -1 && out.length > 0) throw new Error('Unexpected git diff output');

  const entries = parseRaw(raw);
  const sections = groupByPath(parsePatch(patch));
  const changes = entries.map((entry) => {
    const fileSections = sections.get(entry.path);
    if (fileSections === undefined) throw new Error(`git diff printed no patch for ${entry.path}`);
    sections.delete(entry.path);
    return { entry, file: toFileChange(entry, fileSections) };
  });
  if (sections.size > 0) {
    throw new Error(
      `git diff printed patches for unlisted paths: ${[...sections.keys()].join(', ')}`,
    );
  }

  await fillContents(repo, changes);
  const files = changes.map((c) => c.file);
  files.sort((a, b) => comparePaths(a.newPath ?? a.oldPath ?? '', b.newPath ?? b.oldPath ?? ''));

  return ChangeSet.parse({
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    snapshotId: createHash('sha256')
      .update(JSON.stringify([SNAPSHOT_FORMAT, base, head]))
      .digest('hex'),
    target,
    baseRevision: base,
    headRevision: head,
    files,
  });
}

async function resolveCommit(repo: string, revision: string): Promise<string> {
  // --end-of-options keeps a revision such as `--output=x` from being read as an option.
  return gitLine(repo, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
}

/** Whether `commit` is a graft point of a shallow clone, listed in `$GIT_DIR/shallow`. */
async function isShallowBoundary(repo: string, commit: string): Promise<boolean> {
  const shallowFile = resolve(repo, await gitLine(repo, ['rev-parse', '--git-path', 'shallow']));
  return existsSync(shallowFile) && readFileSync(shallowFile, 'utf8').split('\n').includes(commit);
}

interface RawEntry {
  status: string;
  path: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

/** Parses `git diff --raw -z`: `:<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0`. */
function parseRaw(raw: string): RawEntry[] {
  const fields = raw.split('\0');
  const entries: RawEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldOid, newOid, status] = (fields[i] ?? '').slice(1).split(' ');
    const path = fields[i + 1];
    if (!oldMode || !newMode || !oldOid || !newOid || !status || !path) {
      throw new Error(`Unexpected git diff --raw output: ${JSON.stringify(fields[i])}`);
    }
    entries.push({ status, path, oldMode, newMode, oldOid, newOid });
  }
  return entries;
}

function groupByPath(sections: PatchSection[]): Map<string, PatchSection[]> {
  const byPath = new Map<string, PatchSection[]>();
  for (const s of sections) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  return byPath;
}

const STATUS: Record<string, FileChange['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  T: 'type-changed',
};

function toFileChange(entry: RawEntry, sections: PatchSection[]): FileChange {
  const status = STATUS[entry.status];
  if (status === undefined) {
    throw new Error(`Unsupported diff status ${entry.status} for ${entry.path}`);
  }
  const oldPath = status === 'added' ? null : entry.path;
  const newPath = status === 'deleted' ? null : entry.path;
  const binary = sections.some((s) => s.binary);
  return {
    status,
    oldPath,
    newPath,
    oldMode: status === 'added' ? null : entry.oldMode,
    newMode: status === 'deleted' ? null : entry.newMode,
    binary,
    oldContent: null,
    newContent: null,
    contentOmitted: binary ? 'binary' : null,
    // A type change is printed as a deletion followed by an addition; keep both sides' hunks.
    hunks: sections.flatMap((s) =>
      s.hunks.map((h) => ({
        id: stableId('h', [oldPath, newPath, h.oldStart, h.oldLines, h.newStart, h.newLines]),
        ...h,
      })),
    ),
  };
}

/** Reads the old and new blob of every text file in one `git cat-file --batch`. */
async function fillContents(repo: string, changes: { entry: RawEntry; file: FileChange }[]) {
  // Gitlinks (submodules) name a commit in another repository: there is no blob to read.
  const wanted = (file: FileChange, mode: string | null) =>
    !file.binary && mode !== null && mode !== GITLINK_MODE;

  const oids = new Set<string>();
  for (const { entry, file } of changes) {
    if (wanted(file, file.oldMode)) oids.add(entry.oldOid);
    if (wanted(file, file.newMode)) oids.add(entry.newOid);
  }
  if (oids.size === 0) return;

  const blobs = parseCatFileBatch(
    await runGit(repo, ['cat-file', '--batch'], [...oids].map((o) => `${o}\n`).join('')),
  );
  const blob = (oid: string) => {
    const content = blobs.get(oid);
    if (content === undefined) throw new Error(`git cat-file did not return blob ${oid}`);
    return content;
  };
  for (const { entry, file } of changes) {
    if (wanted(file, file.oldMode)) file.oldContent = blob(entry.oldOid);
    if (wanted(file, file.newMode)) file.newContent = blob(entry.newOid);
  }
}

/** Parses `git cat-file --batch` output: `<oid> <type> <size>\n<content>\n` per object. */
function parseCatFileBatch(out: Buffer): Map<string, string> {
  const blobs = new Map<string, string>();
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString('utf8');
    const [oid, type, size] = header.split(' ');
    if (!oid || type !== 'blob' || size === undefined) {
      throw new Error(`Unexpected git cat-file output: ${header}`);
    }
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(oid, out.subarray(start, end).toString('utf8'));
    pos = end + 1;
  }
  return blobs;
}

/** Git's order: plain byte order of the UTF-8 paths. */
function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
