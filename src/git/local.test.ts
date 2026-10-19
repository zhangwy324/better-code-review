import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChangeSet } from '../schemas/index.ts';
import { extractChangeSet } from './extract.ts';
import { SnapshotChangedError } from './local.ts';

// Real working trees this time: the local target reads files from disk. User and system config
// are hidden from both the fixtures and the extractor, so excludes and filters are the repo's.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bcr-home-'));
const ISOLATED = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(CONFIG_DIR, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const saved = Object.fromEntries(Object.keys(ISOLATED).map((k) => [k, process.env[k]]));
beforeAll(() => Object.assign(process.env, ISOLATED));

const dirs: string[] = [CONFIG_DIR];
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

class WorkTree {
  readonly path = mkdtempSync(join(tmpdir(), 'bcr-local-'));

  constructor() {
    dirs.push(this.path);
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'core.autocrlf', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.path,
      env: { ...process.env, ...ISOLATED },
      encoding: 'utf8',
    });
  }

  write(files: Record<string, string | null>): void {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.path, path);
      if (content === null) {
        unlinkSync(full);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }

  commitAll(files: Record<string, string | null>): string {
    this.write(files);
    this.git('add', '--all');
    this.git('commit', '-q', '-m', 'commit');
    return this.git('rev-parse', 'HEAD').trim();
  }

  extract(includeUntracked = true, beforeRecapture?: () => void): Promise<ChangeSet> {
    const target = { kind: 'local', includeUntracked } as const;
    return extractChangeSet(this.path, target, beforeRecapture ? { beforeRecapture } : {});
  }
}

function summary(changes: ChangeSet) {
  return changes.files.map((f) => [f.status, f.newPath ?? f.oldPath, f.newContent]);
}

/** Staged, unstaged, overlapping, deleted, untracked and ignored changes on one commit. */
function buildMixedTree() {
  const tree = new WorkTree();
  const head = tree.commitAll({
    '.gitignore': 'build/\n*.log\n',
    'staged.ts': 'export const a = 1;\n',
    'unstaged.ts': 'export const b = 1;\n',
    'both.ts': 'export const c = 1;\n',
    'removed.ts': 'export const d = 1;\n',
    'rm-cached.ts': 'export const e = 1;\n',
    'kept.ts': 'export const f = 1;\n',
  });
  tree.write({ 'staged.ts': 'export const a = 2;\n', 'both.ts': 'export const c = 2;\n' });
  tree.write({ 'new-staged.ts': 'export const g = 1;\n', 'force-added.log': 'tracked log\n' });
  tree.git('add', 'staged.ts', 'both.ts', 'new-staged.ts');
  tree.git('add', '--force', 'force-added.log');
  tree.git('rm', '-q', '--cached', 'rm-cached.ts');
  tree.write({
    'unstaged.ts': 'export const b = 2;\n',
    'both.ts': 'export const c = 3;\n',
    'removed.ts': null,
    'untracked/new.ts': 'export const h = 1;\n',
    'build/out.js': 'ignored\n',
    'debug.log': 'ignored\n',
  });
  return { tree, head };
}

describe('extractChangeSet: local target', () => {
  const { tree, head } = buildMixedTree();

  it('compares HEAD with the working tree, staged and unstaged together', async () => {
    const changes = await tree.extract();
    expect(changes.baseRevision).toBe(head);
    expect(changes.headRevision).toBeNull();
    expect(changes.target).toEqual({ kind: 'local', includeUntracked: true });
    expect(summary(changes)).toEqual([
      // The working tree wins over the staged version.
      ['modified', 'both.ts', 'export const c = 3;\n'],
      // Tracked despite .gitignore, so included like any tracked file.
      ['added', 'force-added.log', 'tracked log\n'],
      ['added', 'new-staged.ts', 'export const g = 1;\n'],
      ['deleted', 'removed.ts', null],
      // Unstaged from the index but still on disk: untracked, so it comes back unchanged.
      ['modified', 'staged.ts', 'export const a = 2;\n'],
      ['modified', 'unstaged.ts', 'export const b = 2;\n'],
      ['added', 'untracked/new.ts', 'export const h = 1;\n'],
    ]);
    expect(changes.excludedUntrackedPaths).toEqual([]);
  });

  it('lists untracked files it leaves out instead of dropping them silently', async () => {
    const changes = await tree.extract(false);
    expect(summary(changes).map(([, path]) => path)).toEqual([
      'both.ts',
      'force-added.log',
      'new-staged.ts',
      'removed.ts',
      // `git rm --cached` without --untracked files: a deletion, as `git commit -a` would do.
      'rm-cached.ts',
      'staged.ts',
      'unstaged.ts',
    ]);
    expect(changes.excludedUntrackedPaths).toEqual(['rm-cached.ts', 'untracked/new.ts']);
  });

  it('preserves every hunk byte-exactly as `git diff HEAD` prints it', async () => {
    const changes = await tree.extract(false);
    for (const file of changes.files) {
      const path = file.newPath ?? file.oldPath ?? '';
      const diff = tree.git('diff', '--no-renames', 'HEAD', '--', path);
      const firstHunk = diff.indexOf('\n@@ ');
      expect(file.hunks.map((h) => h.patch).join(''), path).toBe(diff.slice(firstHunk + 1));
    }
  });

  it('leaves the user index and staged state untouched', async () => {
    // `git status` refreshes the index file, so it runs before the index is read.
    const status = tree.git('status', '--porcelain=v1', '-z');
    const index = readFileSync(join(tree.path, '.git', 'index'));
    await tree.extract();
    await tree.extract(false);
    expect(readFileSync(join(tree.path, '.git', 'index'))).toEqual(index);
    expect(tree.git('status', '--porcelain=v1', '-z')).toBe(status);
  });

  it('labels the snapshot with an ID that is stable until the working tree changes', async () => {
    const first = await tree.extract();
    expect(first.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(await tree.extract()).toEqual(first);
    // Staging changes nothing that is reviewed, so the snapshot is the same.
    tree.git('add', 'unstaged.ts');
    expect((await tree.extract()).snapshotId).toBe(first.snapshotId);

    tree.write({ 'kept.ts': 'export const f = 2;\n' });
    const edited = await tree.extract();
    expect(edited.snapshotId).not.toBe(first.snapshotId);
    tree.write({ 'kept.ts': 'export const f = 1;\n' });
    expect((await tree.extract()).snapshotId).toBe(first.snapshotId);
  });
});

describe('extractChangeSet: local target edge cases', () => {
  it('reports a clean working tree as no changes', async () => {
    const tree = new WorkTree();
    tree.commitAll({ 'a.txt': 'a\n' });
    const changes = await tree.extract();
    expect(changes.files).toEqual([]);
  });

  it('diffs against the empty tree on a branch with no commits', async () => {
    const tree = new WorkTree();
    tree.write({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    tree.git('add', 'a.txt');
    const changes = await tree.extract(false);
    expect(changes.baseRevision).toBeNull();
    expect(summary(changes)).toEqual([['added', 'a.txt', 'a\n']]);
    expect(changes.excludedUntrackedPaths).toEqual(['b.txt']);
    expect(summary(await tree.extract())).toEqual([
      ['added', 'a.txt', 'a\n'],
      ['added', 'b.txt', 'b\n'],
    ]);
  });

  it('re-reads a file edited in the same timestamp tick as the index was written', async () => {
    // A staged file is rewritten with same-size content and the same mtime as the index: only
    // Git's racy-entry check notices. ctime would give it away, so it is not trusted here.
    const tree = new WorkTree();
    tree.git('config', 'core.trustctime', 'false');
    tree.commitAll({ 'a.ts': 'export const a = 1;\n' });
    const tick = new Date('2026-01-01T00:00:00Z');
    const file = join(tree.path, 'a.ts');
    tree.write({ 'a.ts': 'export const a = 2;\n' });
    utimesSync(file, tick, tick);
    tree.git('add', 'a.ts');
    tree.write({ 'a.ts': 'export const a = 3;\n' });
    utimesSync(file, tick, tick);
    utimesSync(join(tree.path, '.git', 'index'), tick, tick);
    expect(tree.git('diff', 'HEAD', '--', 'a.ts')).toContain('+export const a = 3;');

    expect(summary(await tree.extract())).toEqual([['modified', 'a.ts', 'export const a = 3;\n']]);
  });

  it('works from a subdirectory of the repository', async () => {
    const tree = new WorkTree();
    tree.commitAll({ 'src/a.txt': 'a\n', 'top.txt': 't\n' });
    tree.write({ 'top.txt': 'T\n', 'other.txt': 'o\n' });
    const changes = await extractChangeSet(join(tree.path, 'src'), {
      kind: 'local',
      includeUntracked: true,
    });
    expect(summary(changes).map(([, path]) => path)).toEqual(['other.txt', 'top.txt']);
  });

  it('refuses a bare repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'bcr-bare-'));
    dirs.push(bare);
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    await expect(extractChangeSet(bare, { kind: 'local', includeUntracked: true })).rejects.toThrow(
      /bare repository/,
    );
  });
});

describe('extractChangeSet: concurrent modification of the working tree', () => {
  it.each([
    ['a tracked file is edited', (t: WorkTree) => t.write({ 'a.txt': 'edited\n' }), true],
    ['a file is created', (t: WorkTree) => t.write({ 'new.txt': 'n\n' }), true],
    ['an untracked file appears', (t: WorkTree) => t.write({ 'new.txt': 'n\n' }), false],
    ['HEAD moves', (t: WorkTree) => t.commitAll({ 'a.txt': 'committed\n' }), true],
  ])('detects and reports it when %s', async (_, modify, includeUntracked) => {
    const tree = new WorkTree();
    tree.commitAll({ 'a.txt': 'a\n' });
    tree.write({ 'a.txt': 'b\n' });
    const run = tree.extract(includeUntracked, () => void modify(tree));
    await expect(run).rejects.toBeInstanceOf(SnapshotChangedError);
    await expect(tree.extract(includeUntracked)).resolves.toBeDefined();
  });

  it('ignores edits to ignored files', async () => {
    const tree = new WorkTree();
    tree.commitAll({ '.gitignore': '*.log\n', 'a.txt': 'a\n' });
    const changes = await tree.extract(true, () => tree.write({ 'x.log': 'noise\n' }));
    expect(changes.files).toEqual([]);
  });
});
