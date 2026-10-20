// Git extractor for `commit`, `range` (#10), `local` (#11) and `pr` (#12) targets (design
// reference §8.2, §4.4): resolves the base and head, diffs them, and produces the ChangeSet
// written to changes.json. A `local` head is the working tree captured as a tree object
// (local.ts). A `pr` is looked up with the GitHub CLI and diffed as a merge-base range (pr.ts).
//
// Edge cases (#13, §8.2). Whatever the case, every hunk Git prints is kept.
// - Renames and copies: detected at Git's default 50% similarity, pinned in DIFF_OPTIONS, as
//   `renamed` or `copied` with both paths and both contents; a copy's old side is its source,
//   which may be any file of the base, changed or not (`--find-copies-harder`). Less similar
//   pairs stay a deletion plus an addition. Git compares at most `renameLimit` (default 1000)
//   sources by destinations, squared; past that it detects only copies from changed files, or
//   only exact renames, and the ChangeSet warns `copy-detection-limited` or
//   `rename-detection-skipped`.
// - Deletions: `deleted`, with `newPath` null and the full old content.
// - Binary files: listed with `binary` set, no content and no hunks. Binary is Git's own test
//   (a NUL in the first 8000 bytes, or a `binary`/`-diff` attribute when Git prints the diff).
// - .gitattributes come from the new side: the head commit's (`--attr-source`), or the working
//   tree's for `local`. Git before 2.40 has no `--attr-source`; there the working tree's are
//   used and the ChangeSet warns `attributes-from-working-tree`.
// - Size cap: when either side's blob is over `maxContentBytes` (MAX_CONTENT_BYTES, 1 MiB),
//   neither side's content is stored and `contentOmitted` is `too-large` (D7); hunks are kept.
// - Generated files are stored like any other file. The structural analyzer marks them
//   (`skipped: 'generated'`), as it needs their content to recognise them.
// - Symlinks are never followed: their content is the link target, as Git stores it, and a
//   file that becomes a symlink is `type-changed`. Submodules have no content.
// - Merge commits: a `commit` target diffs against one parent, the first unless `parent` says
//   otherwise, never a combined diff. `range` and `pr` targets use the single merge base and
//   refuse several (criss-cross merges).
// - Shallow clones and missing history fail with a message that says to fetch more history,
//   rather than diff against an empty tree: a commit at the shallow boundary, or a merge base
//   that is not in the clone.
// - Text that is not valid UTF-8 on either side (Latin-1, UTF-16, ...) is listed without content,
//   `contentOmitted` `not-utf8`, so nothing parses or shows garbled text. Its hunks are kept, but
//   their patch text is decoded as UTF-8 too, with U+FFFD for the invalid bytes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHANGESET_SCHEMA_VERSION,
  ChangeSet,
  ExtractionWarning,
  type FileChange,
  GITLINK_MODE,
  type PullRequestInfo,
  type ReviewTarget,
  stableId,
} from '../schemas/index.ts';
import { assertSameSnapshot, captureWorkingTree, comparePaths } from './local.ts';
import { type PatchSection, parsePatch } from './patch.ts';
import { type GhRunner, resolvePullRequest } from './pr.ts';
import { GitError, gitLine, runGit, runGitWithStderr } from './run.ts';

export type RevisionTarget = Extract<ReviewTarget, { kind: 'commit' | 'range' }>;
export type LocalTarget = Extract<ReviewTarget, { kind: 'local' }>;

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
const DIFF_CONFIG = [
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'core.quotePath=true',
  // `git diff` treats blobs over this size as binary. Git's default.
  '-c',
  'core.bigFileThreshold=512m',
];
const DIFF_OPTIONS = [
  // Git's default similarity. The limit (`-l`) is added per run from ExtractOptions.
  '--find-renames=50%',
  '--find-copies=50%',
  '--find-copies-harder',
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
const SNAPSHOT_FORMAT = 'git-revisions/2';
const LOCAL_SNAPSHOT_FORMAT = 'git-local/2';

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
  const ends = `${target.base} and ${target.head}`;
  return {
    base: await mergeBase(repo, base, head, ends, 'use a direct range from the one you want'),
    head,
  };
}

/**
 * The single merge base of two commits: merge-base mode is `git diff base...head`. With several
 * merge bases (criss-cross merges) Git would pick one arbitrarily; ask the user to choose rather
 * than guess. `ends` names the two commits and `choose` says how to pick one, in error messages.
 */
async function mergeBase(
  repo: string,
  base: string,
  head: string,
  ends: string,
  choose: string,
): Promise<string> {
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
      `${ends} have no common ancestor` +
        (shallow ? ' in this shallow clone; fetch more history and try again' : ''),
    );
  }
  const [only] = mergeBases;
  if (mergeBases.length > 1 || only === undefined) {
    throw new Error(
      `${ends} have ${mergeBases.length} merge bases (${mergeBases.join(', ')}); ${choose}`,
    );
  }
  return only;
}

export interface ExtractOptions {
  /** Test hook: runs between the two working-tree captures of a `local` target. */
  beforeRecapture?: () => void | Promise<void>;
  /** Test hook: runs the GitHub CLI for a `pr` target. Defaults to the real `gh`. */
  gh?: GhRunner;
  /** Content size cap per side, in bytes. Defaults to MAX_CONTENT_BYTES. */
  maxContentBytes?: number;
  /**
   * Git's rename limit (`-l`) for rename and copy detection. Defaults to DEFAULT_RENAME_LIMIT.
   * It can change which files pair up, so it is part of the snapshot ID.
   */
  renameLimit?: number;
  /** Test hook: the `git version` output to assume. Defaults to the installed Git's. */
  gitVersion?: string;
}

/**
 * Files with a side over this size are stored without content (D7). It matches the structural
 * analyzer's parse cap (MAX_PARSE_BYTES), above which content would only be shown, not analysed.
 */
export const MAX_CONTENT_BYTES = 1024 * 1024;

/** Git's own default for `diff.renameLimit`. */
export const DEFAULT_RENAME_LIMIT = 1000;

function diffSettings(options: ExtractOptions, attrSource: string | null): DiffSettings {
  return {
    maxContentBytes: options.maxContentBytes ?? MAX_CONTENT_BYTES,
    renameLimit: options.renameLimit ?? DEFAULT_RENAME_LIMIT,
    attrSource,
  };
}

/** Extracts the ChangeSet for a target in the repository at `repo`. */
export async function extractChangeSet(
  repo: string,
  target: ReviewTarget,
  options: ExtractOptions = {},
): Promise<ChangeSet> {
  if (target.kind === 'local') return extractLocal(repo, target, options);

  let base: string | null;
  let head: string;
  let pullRequest: PullRequestInfo | null = null;
  if (target.kind === 'pr') {
    const pr = await resolvePullRequest(repo, target.number, options.gh);
    const { baseRefName, headRefName } = pr.info;
    const ends =
      `Pull request #${target.number}'s base ${baseRefName} (${pr.base.slice(0, 7)}) ` +
      `and head ${headRefName} (${pr.head.slice(0, 7)})`;
    const choose = `review it as a direct range from the one you want to ${pr.head}`;
    base = await mergeBase(repo, pr.base, pr.head, ends, choose);
    head = pr.head;
    pullRequest = pr.info;
  } else {
    ({ base, head } = await resolveRevisions(repo, target));
  }
  // .gitattributes can change hunks (`binary`, `-diff`, `diff=<driver>`), so they are read from
  // the head commit rather than from whatever the working tree holds.
  const version = options.gitVersion ?? (await gitLine(repo, ['version']));
  const attrSource = supportsAttrSource(version) ? head : null;
  const settings = diffSettings(options, attrSource);
  const diff = await diffFiles(repo, base, head, settings);
  const warnings = new Set(diff.warnings);
  if (attrSource === null) warnings.add('attributes-from-working-tree');
  return ChangeSet.parse({
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    snapshotId: createHash('sha256')
      .update(JSON.stringify([SNAPSHOT_FORMAT, base, head, settings.renameLimit]))
      .digest('hex'),
    target,
    baseRevision: base,
    headRevision: head,
    files: diff.files,
    excludedUntrackedPaths: [],
    pullRequest,
    warnings: ExtractionWarning.options.filter((w) => warnings.has(w)),
  });
}

/**
 * The working tree is captured twice, before and after the diff. Each capture reads files one
 * at a time, so an edit during the first could mix old and new files; if the two disagree the
 * extraction fails rather than review a state that never existed. The diff itself reads only
 * the immutable tree, so nothing written after the first capture can leak into the result.
 */
async function extractLocal(
  repo: string,
  target: LocalTarget,
  options: ExtractOptions,
): Promise<ChangeSet> {
  const snapshot = await captureWorkingTree(repo, target.includeUntracked);
  // The working tree is the new side, so its .gitattributes are the right ones.
  const settings = diffSettings(options, null);
  const { files, warnings } = await diffFiles(repo, snapshot.head, snapshot.tree, settings);
  await options.beforeRecapture?.();
  assertSameSnapshot(snapshot, await captureWorkingTree(repo, target.includeUntracked));

  return ChangeSet.parse({
    schemaVersion: CHANGESET_SCHEMA_VERSION,
    snapshotId: createHash('sha256')
      .update(
        JSON.stringify([LOCAL_SNAPSHOT_FORMAT, snapshot.head, snapshot.tree, settings.renameLimit]),
      )
      .digest('hex'),
    target,
    baseRevision: snapshot.head,
    headRevision: null,
    files,
    excludedUntrackedPaths: snapshot.excludedUntracked,
    pullRequest: null,
    warnings,
  });
}

/** Whether `git version` output names a Git with `--attr-source` (2.40 or later). */
export function supportsAttrSource(gitVersion: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(gitVersion);
  if (!m) throw new Error(`Unexpected git version output: ${gitVersion}`);
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

interface DiffSettings {
  maxContentBytes: number;
  renameLimit: number;
  /** The tree-ish whose .gitattributes the diff reads; null for the working tree's. */
  attrSource: string | null;
}

interface DiffResult {
  files: FileChange[];
  warnings: ExtractionWarning[];
}

/** Diffs two tree-ish objects; a null base is the empty tree. */
async function diffFiles(
  repo: string,
  base: string | null,
  head: string,
  settings: DiffSettings,
): Promise<DiffResult> {
  const baseTree = base ?? (await gitLine(repo, ['hash-object', '-t', 'tree', '--stdin'], ''));
  const range = [baseTree, head];

  // One diff prints both the file list (`--raw`, NUL-separated) and the patch, so the two
  // always describe the same comparison. An empty NUL field separates them.
  const args = [
    ...(settings.attrSource === null ? [] : [`--attr-source=${settings.attrSource}`]),
    ...DIFF_CONFIG,
    'diff',
    '--raw',
    '--patch',
    '-z',
    '--no-abbrev',
    ...DIFF_OPTIONS,
    `-l${settings.renameLimit}`,
    ...range,
  ];
  // The C locale keeps Git's warnings in English, so that they can be recognised.
  const { stdout: out, stderr } = await runGitWithStderr(repo, args, '', { LC_ALL: 'C' });
  const separator = out.indexOf('\0\0');
  const raw = separator === -1 ? '' : out.subarray(0, separator + 1).toString('utf8');
  const patch = separator === -1 ? '' : out.subarray(separator + 2).toString('utf8');
  if (separator === -1 && out.length > 0) throw new Error('Unexpected git diff output');

  const entries = parseRaw(raw);
  const sections = groupByPaths(parsePatch(patch));
  const changes = entries.map((entry) => {
    const key = pathsKey(entry.oldPath, entry.newPath);
    const fileSections = sections.get(key);
    if (fileSections === undefined) {
      throw new Error(`git diff printed no patch for ${entry.newPath}`);
    }
    sections.delete(key);
    return { entry, file: toFileChange(entry, fileSections) };
  });
  if (sections.size > 0) {
    const paths = [...sections.values()].map(([s]) => s?.newPath);
    throw new Error(`git diff printed patches for unlisted paths: ${paths.join(', ')}`);
  }

  await fillContents(repo, changes, settings.maxContentBytes);
  const files = changes.map((c) => c.file);
  files.sort((a, b) => comparePaths(a.newPath ?? a.oldPath ?? '', b.newPath ?? b.oldPath ?? ''));
  return { files, warnings: renameLimitWarnings(stderr) };
}

/**
 * Git's warnings when a diff was over the rename limit (diffcore-rename.c): with
 * `--find-copies-harder` it first falls back to copies from changed files only, and past that
 * it skips inexact rename and copy detection altogether.
 */
function renameLimitWarnings(stderr: string): ExtractionWarning[] {
  const warnings: ExtractionWarning[] = [];
  if (/only found copies from modified paths/.test(stderr)) warnings.push('copy-detection-limited');
  if (/rename detection was skipped/.test(stderr)) warnings.push('rename-detection-skipped');
  return warnings;
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
  /** The status letter, without a rename's or copy's similarity score. */
  status: string;
  /** Equal to `newPath` unless the file was renamed or copied. */
  oldPath: string;
  newPath: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
}

/**
 * Parses `git diff --raw -z`: `:<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0`,
 * where a rename's or copy's status is `R<score>` or `C<score>` and it has two paths, old
 * (the source) then new.
 */
function parseRaw(raw: string): RawEntry[] {
  const fields = raw.split('\0');
  const entries: RawEntry[] = [];
  let i = 0;
  while (i + 1 < fields.length) {
    const meta = fields[i++] ?? '';
    const [oldMode, newMode, oldOid, newOid, score] = meta.slice(1).split(' ');
    const status = score?.[0];
    const oldPath = fields[i++];
    const newPath = status === 'R' || status === 'C' ? fields[i++] : oldPath;
    if (!oldMode || !newMode || !oldOid || !newOid || !status || !oldPath || !newPath) {
      throw new Error(`Unexpected git diff --raw output: ${JSON.stringify(meta)}`);
    }
    entries.push({ status, oldPath, newPath, oldMode, newMode, oldOid, newOid });
  }
  return entries;
}

function pathsKey(oldPath: string, newPath: string): string {
  return `${oldPath}\0${newPath}`;
}

function groupByPaths(sections: PatchSection[]): Map<string, PatchSection[]> {
  const byPaths = new Map<string, PatchSection[]>();
  for (const s of sections) {
    const key = pathsKey(s.oldPath, s.newPath);
    byPaths.set(key, [...(byPaths.get(key) ?? []), s]);
  }
  return byPaths;
}

const STATUS: Record<string, FileChange['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

function toFileChange(entry: RawEntry, sections: PatchSection[]): FileChange {
  const status = STATUS[entry.status];
  if (status === undefined) {
    throw new Error(`Unsupported diff status ${entry.status} for ${entry.newPath}`);
  }
  const oldPath = status === 'added' ? null : entry.oldPath;
  const newPath = status === 'deleted' ? null : entry.newPath;
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

/** Git's own test for binary content: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Reads the old and new blob of every text file under the size cap. Sizes come first from one
 * `git cat-file --batch-check`, so blobs over the cap are never loaded, then the contents from
 * one `git cat-file --batch`.
 */
async function fillContents(
  repo: string,
  changes: { entry: RawEntry; file: FileChange }[],
  maxContentBytes: number,
) {
  // The blobs on the sides where the file exists. Gitlinks (submodules) name a commit in another
  // repository: there is no blob to read.
  const sides = ({ entry, file }: (typeof changes)[number]) =>
    [
      { oid: entry.oldOid, mode: file.oldMode, set: (c: string) => (file.oldContent = c) },
      { oid: entry.newOid, mode: file.newMode, set: (c: string) => (file.newContent = c) },
    ].filter((s) => s.mode !== null && s.mode !== GITLINK_MODE);
  const text = changes.filter((c) => !c.file.binary && sides(c).length > 0);
  if (text.length === 0) return;

  const sizes = parseCatFile(await catFile(repo, '--batch-check', text.flatMap(sides)), false);
  const toRead = text.filter((c) => {
    const tooLarge = sides(c).some((s) => blobOf(sizes, s.oid).size > maxContentBytes);
    if (tooLarge) c.file.contentOmitted = 'too-large';
    return !tooLarge;
  });
  if (toRead.length === 0) return;

  const blobs = parseCatFile(await catFile(repo, '--batch', toRead.flatMap(sides)), true);
  for (const change of toRead) {
    const contents = sides(change).map((s) => blobOf(blobs, s.oid).content);
    // Git found no binary hunk to print for a pure rename or a mode-only change, so apply its
    // test here too: such a file must not be read as text.
    if (contents.some((c) => c.subarray(0, BINARY_SNIFF_BYTES).includes(0))) {
      change.file.binary = true;
      change.file.contentOmitted = 'binary';
      continue;
    }
    const texts = contents.map(decodeUtf8);
    if (texts.includes(null)) {
      change.file.contentOmitted = 'not-utf8';
      continue;
    }
    sides(change).forEach((s, i) => s.set(texts[i] ?? ''));
  }
}

/** Strict UTF-8 that keeps a byte order mark, so lines and columns match the file. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of a blob, or null when it is not valid UTF-8. */
function decodeUtf8(content: Buffer): string | null {
  try {
    return UTF8.decode(content);
  } catch {
    return null;
  }
}

function catFile(repo: string, mode: string, blobs: { oid: string }[]): Promise<Buffer> {
  const oids = new Set(blobs.map((b) => b.oid));
  return runGit(repo, ['cat-file', mode], [...oids].map((o) => `${o}\n`).join(''));
}

interface Blob {
  size: number;
  /** Empty when only sizes were read. */
  content: Buffer;
}

function blobOf(blobs: Map<string, Blob>, oid: string): Blob {
  const blob = blobs.get(oid);
  if (blob === undefined) throw new Error(`git cat-file did not return blob ${oid}`);
  return blob;
}

/**
 * Parses `git cat-file --batch-check` (`<oid> <type> <size>\n` per object) or, `withContent`,
 * `--batch` output, which follows each header with `<content>\n`.
 */
function parseCatFile(out: Buffer, withContent: boolean): Map<string, Blob> {
  const blobs = new Map<string, Blob>();
  let pos = 0;
  while (pos < out.length) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString('utf8');
    const [oid, type, sizeField] = header.split(' ');
    if (!oid || type !== 'blob' || sizeField === undefined) {
      throw new Error(`Unexpected git cat-file output: ${header}`);
    }
    const size = Number(sizeField);
    pos = eol + 1;
    const content = withContent ? out.subarray(pos, pos + size) : Buffer.alloc(0);
    if (withContent) pos += size + 1;
    blobs.set(oid, { size, content });
  }
  return blobs;
}
