import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '../schemas/index.ts';
import { extractChangeSet } from './extract.ts';
import { hunkLines } from './patch.ts';
import { TestRepo } from './test-repo.test-helper.ts';

const PRICE_OLD = [
  'export function formatPrice(amount: number): string {',
  '  return amount.toFixed(2);',
  '}',
  '',
  ...Array.from({ length: 12 }, (_, i) => `// filler ${i + 1}`),
  '',
  'export const VAT = 0.2;',
  '',
].join('\n');
const PRICE_NEW = PRICE_OLD.replace(
  'formatPrice(amount: number): string {\n  return amount.toFixed(2);',
  'formatPrice(amount: number, currency: string): string {\n  return `${amount.toFixed(2)} ${currency}`;',
).replace('VAT = 0.2', 'VAT = 0.25');

/** A base and head commit covering the statuses and awkward paths #10 must handle. */
function buildSignatureRepo() {
  const repo = new TestRepo();
  const base = repo.commit([], {
    'src/price.ts': PRICE_OLD,
    'src/checkout.ts': "import { formatPrice } from './price';\nexport const c = formatPrice(1);\n",
    'README.md': '# Fixture\n',
    'docs/notes with spaces.md': 'one\ntwo\n',
    'naïve/quo"te\ttab.txt': 'alpha\n',
    'no-newline.txt': 'first\nlast',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    'run.sh': '#!/bin/sh\necho hi\n',
    'old-name.ts': 'export const moved = 1;\n',
  });
  const head = repo.commit([base], {
    'src/price.ts': PRICE_NEW,
    'src/checkout.ts':
      "import { formatPrice } from './price';\nexport const c = formatPrice(1, 'EUR');\n",
    'src/new.ts': 'export const added = true;\n',
    'README.md': null,
    'docs/notes with spaces.md': 'one\n2\n',
    'naïve/quo"te\ttab.txt': 'beta\n',
    'no-newline.txt': 'first\nlast!',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]),
    'run.sh': { mode: '100755', content: '#!/bin/sh\necho hi\n' },
    'old-name.ts': null,
    'new-name.ts': 'export const moved = 1;\n',
  });
  return { repo, base, head };
}

/** Every hunk `git diff` prints is in the ChangeSet, byte for byte, under the right file. */
function expectGitHunks(repo: TestRepo, base: string, head: string, changes: ChangeSet) {
  const fullDiff = repo.git('diff', '-M', base, head);
  const hunkCount = changes.files.reduce((n, f) => n + f.hunks.length, 0);
  expect(hunkCount).toBe(fullDiff.match(/^@@ /gm)?.length ?? 0);

  for (const file of changes.files) {
    // Both of a rename's paths, so that Git still pairs them.
    const paths = [...new Set([file.oldPath, file.newPath].filter((p) => p !== null))];
    // A type change prints two sections; take the hunks of each.
    const hunkText = repo
      .git('diff', '-M', base, head, '--', ...paths)
      .split(/^(?=diff --git )/m)
      .map((section) => {
        const firstHunk = section.indexOf('\n@@ ');
        return firstHunk === -1 ? '' : section.slice(firstHunk + 1);
      })
      .join('');
    expect(file.hunks.map((h) => h.patch).join(''), paths.join(' -> ')).toBe(hunkText);
  }
}

function byPath(changes: ChangeSet, path: string) {
  const file = changes.files.find((f) => (f.newPath ?? f.oldPath) === path);
  if (!file) throw new Error(`no change for ${path}`);
  return file;
}

describe('extractChangeSet: commit target', () => {
  const { repo, base, head } = buildSignatureRepo();
  const extract = () => extractChangeSet(repo.path, { kind: 'commit', commit: head });

  it('resolves the commit and its first parent', async () => {
    const changes = await extract();
    expect(changes.baseRevision).toBe(base);
    expect(changes.headRevision).toBe(head);
    expect(changes.target).toEqual({ kind: 'commit', commit: head });
    expect(changes.snapshotId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports status, paths and modes per file, sorted by path', async () => {
    const changes = await extract();
    expect(
      changes.files.map((f) => [f.status, f.oldPath, f.newPath, f.oldMode, f.newMode, f.binary]),
    ).toEqual([
      ['deleted', 'README.md', null, '100644', null, false],
      [
        'modified',
        'docs/notes with spaces.md',
        'docs/notes with spaces.md',
        '100644',
        '100644',
        false,
      ],
      ['modified', 'logo.png', 'logo.png', '100644', '100644', true],
      ['modified', 'naïve/quo"te\ttab.txt', 'naïve/quo"te\ttab.txt', '100644', '100644', false],
      ['renamed', 'old-name.ts', 'new-name.ts', '100644', '100644', false],
      ['modified', 'no-newline.txt', 'no-newline.txt', '100644', '100644', false],
      ['modified', 'run.sh', 'run.sh', '100644', '100755', false],
      ['modified', 'src/checkout.ts', 'src/checkout.ts', '100644', '100644', false],
      ['added', null, 'src/new.ts', null, '100644', false],
      ['modified', 'src/price.ts', 'src/price.ts', '100644', '100644', false],
    ]);
  });

  it('captures full before/after contents of text files, and none for binaries', async () => {
    const changes = await extract();
    const price = byPath(changes, 'src/price.ts');
    expect([price.oldContent, price.newContent, price.contentOmitted]).toEqual([
      PRICE_OLD,
      PRICE_NEW,
      null,
    ]);
    expect(byPath(changes, 'src/new.ts')).toMatchObject({
      oldContent: null,
      newContent: 'export const added = true;\n',
    });
    expect(byPath(changes, 'README.md')).toMatchObject({
      oldContent: '# Fixture\n',
      newContent: null,
    });
    expect(byPath(changes, 'no-newline.txt').newContent).toBe('first\nlast!');
    expect(byPath(changes, 'logo.png')).toMatchObject({
      oldContent: null,
      newContent: null,
      contentOmitted: 'binary',
      hunks: [],
    });
    // A mode-only change has contents but no hunks.
    expect(byPath(changes, 'run.sh')).toMatchObject({
      hunks: [],
      oldContent: '#!/bin/sh\necho hi\n',
    });
  });

  it('preserves every hunk byte-exactly as `git diff` prints it', async () => {
    const changes = await extract();
    expectGitHunks(repo, base, head, changes);
    expect(byPath(changes, 'src/price.ts').hunks).toHaveLength(2);
  });

  it('ignores repository config that would turn text into binary', async () => {
    const expected = await extract();
    repo.git('config', 'core.bigFileThreshold', '10');
    try {
      expect(await extract()).toEqual(expected);
    } finally {
      repo.git('config', '--unset', 'core.bigFileThreshold');
    }
  });

  it('maps every hunk line to the matching line of the old and new content', async () => {
    const changes = await extract();
    for (const file of changes.files) {
      const oldLines = file.oldContent?.split('\n') ?? [];
      const newLines = file.newContent?.split('\n') ?? [];
      for (const hunk of file.hunks) {
        for (const line of hunkLines(hunk)) {
          if (line.oldLine !== null) expect(oldLines[line.oldLine - 1]).toBe(line.text);
          if (line.newLine !== null) expect(newLines[line.newLine - 1]).toBe(line.text);
        }
      }
    }
    expect(byPath(changes, 'src/price.ts').hunks.map((h) => h.patch.split('\n')[0])).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -15,4 +15,4 @@ export function formatPrice(amount: number): string {',
    ]);
  });

  it('gives hunks unique IDs that are identical across runs and across identical repositories', async () => {
    const first = await extract();
    const ids = first.files.flatMap((f) => f.hunks.map((h) => h.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(await extract()).toEqual(first);

    const twin = buildSignatureRepo();
    expect(twin.head).toBe(head);
    expect(await extractChangeSet(twin.repo.path, { kind: 'commit', commit: head })).toEqual(first);
  });

  it('accepts any revision expression and rejects option-like or unknown ones', async () => {
    repo.git('update-ref', 'refs/heads/feature', head);
    const viaBranch = await extractChangeSet(repo.path, { kind: 'commit', commit: 'feature' });
    expect(viaBranch.headRevision).toBe(head);
    expect(viaBranch.snapshotId).toBe((await extract()).snapshotId);

    await expect(extractChangeSet(repo.path, { kind: 'commit', commit: 'nope' })).rejects.toThrow();
    await expect(
      extractChangeSet(repo.path, { kind: 'commit', commit: '--output=injected' }),
    ).rejects.toThrow();
    expect(existsSync(join(repo.path, 'injected'))).toBe(false);
  });
});

describe('extractChangeSet: parents', () => {
  const repo = new TestRepo();
  const root = repo.commit([], { 'a.txt': 'a\n', 'empty.txt': '' });
  const left = repo.commit([root], { 'left.txt': 'left\n' });
  const right = repo.commit([root], { 'right.txt': 'right\n' });
  const merge = repo.commit([left, right], { 'right.txt': 'right\n' });

  it('diffs a root commit against the empty tree', async () => {
    const changes = await extractChangeSet(repo.path, { kind: 'commit', commit: root });
    expect(changes.baseRevision).toBeNull();
    expect(changes.files.map((f) => [f.status, f.newPath, f.newContent])).toEqual([
      ['added', 'a.txt', 'a\n'],
      ['added', 'empty.txt', ''],
    ]);
    expect(changes.files[0]?.hunks.map((h) => h.patch)).toEqual(['@@ -0,0 +1 @@\n+a\n']);
    expect(changes.files[1]?.hunks).toEqual([]);
  });

  it('diffs a merge commit against the selected parent', async () => {
    const m = merge;
    const first = await extractChangeSet(repo.path, { kind: 'commit', commit: m });
    expect(first.baseRevision).toBe(left);
    expect(first.files.map((f) => f.newPath)).toEqual(['right.txt']);

    const second = await extractChangeSet(repo.path, { kind: 'commit', commit: m, parent: 2 });
    expect(second.baseRevision).toBe(right);
    expect(second.files.map((f) => f.newPath)).toEqual(['left.txt']);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    await expect(
      extractChangeSet(repo.path, { kind: 'commit', commit: m, parent: 3 }),
    ).rejects.toThrow(/has 2 parent/);
    await expect(
      extractChangeSet(repo.path, { kind: 'commit', commit: root, parent: 2 }),
    ).rejects.toThrow(/root commit/);
  });

  it('refuses a commit at a shallow-clone boundary instead of diffing against nothing', async () => {
    const clone = new TestRepo();
    repo.git('update-ref', 'refs/heads/main', left);
    clone.git('fetch', '-q', '--depth=1', pathToFileURL(repo.path).href, 'main');
    await expect(
      extractChangeSet(clone.path, { kind: 'commit', commit: 'FETCH_HEAD' }),
    ).rejects.toThrow(/shallow clone/);
  });

  it('diffs a commit inside a shallow clone normally', async () => {
    const clone = new TestRepo();
    repo.git('update-ref', 'refs/heads/main', left);
    clone.git('fetch', '-q', '--depth=2', pathToFileURL(repo.path).href, 'main');
    const changes = await extractChangeSet(clone.path, { kind: 'commit', commit: 'FETCH_HEAD' });
    expect([changes.baseRevision, changes.headRevision]).toEqual([root, left]);
  });
});

describe('extractChangeSet: range target', () => {
  const repo = new TestRepo();
  const fork = repo.commit([], { 'shared.txt': 'v1\n', 'main.txt': 'm1\n' });
  const main = repo.commit([fork], { 'main.txt': 'm2\n' });
  const feature = repo.commit([fork], { 'shared.txt': 'v2\n' });
  repo.git('update-ref', 'refs/heads/main', main);
  repo.git('update-ref', 'refs/heads/feature', feature);

  it('diffs base..head directly in direct mode', async () => {
    const target = { kind: 'range', base: 'main', head: 'feature', mode: 'direct' } as const;
    const changes = await extractChangeSet(repo.path, target);
    expect([changes.baseRevision, changes.headRevision]).toEqual([main, feature]);
    // The other branch's change shows up reversed: that is what two-dot means.
    expect(changes.files.map((f) => [f.newPath, f.oldContent, f.newContent])).toEqual([
      ['main.txt', 'm2\n', 'm1\n'],
      ['shared.txt', 'v1\n', 'v2\n'],
    ]);
  });

  it('diffs merge-base..head in merge-base mode', async () => {
    const target = { kind: 'range', base: 'main', head: 'feature', mode: 'merge-base' } as const;
    const changes = await extractChangeSet(repo.path, target);
    expect([changes.baseRevision, changes.headRevision]).toEqual([fork, feature]);
    expect(changes.files.map((f) => f.newPath)).toEqual(['shared.txt']);
  });

  it('refuses ambiguous (criss-cross) and missing merge bases', async () => {
    const m1 = repo.commit([main, feature], {});
    const m2 = repo.commit([feature, main], {});
    await expect(
      extractChangeSet(repo.path, { kind: 'range', base: m1, head: m2, mode: 'merge-base' }),
    ).rejects.toThrow(/2 merge bases/);

    const orphan = repo.commit([], { 'x.txt': 'x\n' });
    await expect(
      extractChangeSet(repo.path, { kind: 'range', base: main, head: orphan, mode: 'merge-base' }),
    ).rejects.toThrow(/no common ancestor/);
  });

  it('says to fetch more history when the merge base is outside a shallow clone', async () => {
    const clone = new TestRepo();
    const url = pathToFileURL(repo.path).href;
    clone.git('fetch', '-q', '--depth=1', url, 'main:refs/tags/main', 'feature:refs/tags/feature');
    const target = { kind: 'range', base: 'main', head: 'feature', mode: 'merge-base' } as const;
    await expect(extractChangeSet(clone.path, target)).rejects.toThrow(
      /no common ancestor in this shallow clone; fetch more history/,
    );
    // A direct range needs no history beyond its two ends.
    const direct = await extractChangeSet(clone.path, { ...target, mode: 'direct' });
    expect([direct.baseRevision, direct.headRevision]).toEqual([main, feature]);
  });
});

describe('extractChangeSet: symlinks, type changes and submodules', () => {
  it('stores symlinks as their target path, never followed, and submodules without content', async () => {
    const repo = new TestRepo();
    const base = repo.commit([], {
      link: 'regular file\n',
      'sym-target': 'x\n',
      retargeted: { mode: '120000', content: 'sym-target' },
      'gone-link': { mode: '120000', content: '../outside/the/repo' },
    });
    const head = repo.commit([base], {
      link: { mode: '120000', content: 'sym-target' },
      'new-link': { mode: '120000', content: 'sym-target' },
      retargeted: { mode: '120000', content: 'link' },
      'gone-link': null,
    });
    repo.git('update-index', '--add', '--cacheinfo', `160000,${base},vendor/sub`);
    const withSubmodule = repo.git(
      'commit-tree',
      repo.git('write-tree').trim(),
      '-p',
      head,
      '-m',
      's',
    );

    const changes = await extractChangeSet(repo.path, { kind: 'commit', commit: head });
    const link = byPath(changes, 'link');
    expect(link).toMatchObject({
      status: 'type-changed',
      oldMode: '100644',
      newMode: '120000',
      oldContent: 'regular file\n',
      newContent: 'sym-target',
    });
    // Git prints a type change as a deletion and an addition; both hunks are kept.
    expect(link.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 1, 0, 0],
      [0, 0, 1, 1],
    ]);
    expect(byPath(changes, 'new-link')).toMatchObject({
      status: 'added',
      newContent: 'sym-target',
    });
    expect(byPath(changes, 'retargeted')).toMatchObject({
      status: 'modified',
      oldMode: '120000',
      newMode: '120000',
      oldContent: 'sym-target',
      newContent: 'link',
    });
    expect(byPath(changes, 'gone-link')).toMatchObject({
      status: 'deleted',
      oldContent: '../outside/the/repo',
    });
    expectGitHunks(repo, base, head, changes);

    const sub = await extractChangeSet(repo.path, { kind: 'commit', commit: withSubmodule.trim() });
    expect(sub.files).toHaveLength(1);
    expect(sub.files[0]).toMatchObject({ status: 'added', newMode: '160000', newContent: null });
    expect(sub.files[0]?.hunks.map((h) => h.patch)).toEqual([
      `@@ -0,0 +1 @@\n+Subproject commit ${base}\n`,
    ]);
  });
});

describe('extractChangeSet: renames', () => {
  const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const repo = new TestRepo();
  const base = repo.commit([], {
    'pure.ts': 'export const pure = 1;\n',
    'edited.ts': body,
    'naïve old.txt': `${body}naïve\n`,
    'image.png': png,
    'rewritten.ts': body,
  });
  const head = repo.commit([base], {
    'pure.ts': null,
    'moved/pure.ts': 'export const pure = 1;\n',
    'edited.ts': null,
    'moved/edited.ts': body.replace('line 5', 'line five'),
    'naïve old.txt': null,
    'new "name".txt': `${body}naïve\n`,
    'image.png': null,
    'assets/image.png': png,
    'rewritten.ts': null,
    'replacement.ts': 'something else entirely\n',
  });

  it('pairs old and new paths, keeping both contents and the edit hunks', async () => {
    const changes = await extractChangeSet(repo.path, { kind: 'commit', commit: head });
    expect(changes.files.map((f) => [f.status, f.oldPath, f.newPath, f.hunks.length])).toEqual([
      ['renamed', 'image.png', 'assets/image.png', 0],
      ['renamed', 'edited.ts', 'moved/edited.ts', 1],
      ['renamed', 'pure.ts', 'moved/pure.ts', 0],
      ['renamed', 'naïve old.txt', 'new "name".txt', 0],
      // Under 50% similar: a deletion and an unrelated addition.
      ['added', null, 'replacement.ts', 1],
      ['deleted', 'rewritten.ts', null, 1],
    ]);
    expect(byPath(changes, 'moved/edited.ts')).toMatchObject({
      oldMode: '100644',
      newMode: '100644',
      oldContent: body,
      newContent: body.replace('line 5', 'line five'),
    });
    expect(byPath(changes, 'assets/image.png')).toMatchObject({
      binary: true,
      contentOmitted: 'binary',
    });
    expectGitHunks(repo, base, head, changes);
  });
});

describe('extractChangeSet: deletions, binary, huge and generated files', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const big = 'x'.repeat(99) + '\n';
  const repo = new TestRepo();
  const base = repo.commit([], {
    'deleted.ts': 'export const gone = 1;\n',
    'deleted-empty.txt': '',
    'deleted.png': png,
    'chmod.png': png,
    'grows.txt': 'small\n',
    'shrinks.txt': big.repeat(3),
    'huge-binary.bin': Buffer.concat([png, Buffer.from(big.repeat(3))]),
  });
  const head = repo.commit([base], {
    'deleted.ts': null,
    'deleted-empty.txt': null,
    'deleted.png': null,
    'chmod.png': { mode: '100755', content: png },
    'grows.txt': `small\n${big.repeat(3)}`,
    'shrinks.txt': 'small\n',
    'huge-binary.bin': Buffer.concat([png, Buffer.from(big.repeat(4))]),
    'app.min.js': 'var a=1;\n',
  });
  // Low enough that the 300-byte sides are over it.
  const extract = () =>
    extractChangeSet(repo.path, { kind: 'commit', commit: head }, { maxContentBytes: 200 });

  it('keeps the full old content and hunks of deleted files', async () => {
    const changes = await extract();
    expect(byPath(changes, 'deleted.ts')).toMatchObject({
      status: 'deleted',
      newPath: null,
      newMode: null,
      oldContent: 'export const gone = 1;\n',
      newContent: null,
      hunks: [{ patch: '@@ -1 +0,0 @@\n-export const gone = 1;\n' }],
    });
    expect(byPath(changes, 'deleted-empty.txt')).toMatchObject({ oldContent: '', hunks: [] });
  });

  it('lists binary files without content or hunks, even when Git printed no diff', async () => {
    const changes = await extract();
    for (const path of ['deleted.png', 'chmod.png', 'huge-binary.bin']) {
      expect(byPath(changes, path), path).toMatchObject({
        binary: true,
        oldContent: null,
        newContent: null,
        contentOmitted: 'binary',
        hunks: [],
      });
    }
    // A mode-only change: Git prints no "Binary files differ", but the file is still binary.
    expect(byPath(changes, 'chmod.png')).toMatchObject({ oldMode: '100644', newMode: '100755' });
  });

  it('omits both sides of a file over the size cap and keeps its hunks', async () => {
    const changes = await extract();
    for (const path of ['grows.txt', 'shrinks.txt']) {
      const file = byPath(changes, path);
      expect([file.binary, file.oldContent, file.newContent, file.contentOmitted], path).toEqual([
        false,
        null,
        null,
        'too-large',
      ]);
      expect(file.hunks, path).toHaveLength(1);
    }
    expectGitHunks(repo, base, head, changes);

    const uncapped = await extractChangeSet(repo.path, { kind: 'commit', commit: head });
    expect(byPath(uncapped, 'grows.txt').newContent).toBe(`small\n${big.repeat(3)}`);
  });

  it('stores generated files like any other; the structural analyzer marks them', async () => {
    const changes = await extract();
    expect(byPath(changes, 'app.min.js')).toMatchObject({
      newContent: 'var a=1;\n',
      contentOmitted: null,
    });
  });
});
