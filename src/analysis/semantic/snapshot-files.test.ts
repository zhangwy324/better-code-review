import { describe, expect, it } from 'vitest';
import { extractChangeSet } from '../../git/extract.ts';
import { TestRepo } from '../../git/test-repo.test-helper.ts';
import { changeSetFiles, gitSnapshotFiles } from './snapshot-files.ts';

async function fixture() {
  const repo = new TestRepo();
  const base = repo.commit([], {
    'same.ts': 'export const formatPrice = 1;\n',
    'edit.ts': 'old formatPrice\n',
    'gone.ts': 'formatPrice\n',
    'other.ts': 'nothing here\n',
  });
  const head = repo.commit([base], {
    'edit.ts': 'new\n',
    'gone.ts': null,
    'added.ts': 'formatPrice()\n',
  });
  const changes = await extractChangeSet(repo.path, { kind: 'commit', commit: head });
  return { repo, base, changes };
}

describe('gitSnapshotFiles', () => {
  it('reads changed files from the ChangeSet and unchanged ones from Git', async () => {
    const { repo, changes } = await fixture();
    const files = gitSnapshotFiles(repo.path, changes);
    expect(await files.read('old', 'edit.ts')).toBe('old formatPrice\n');
    expect(await files.read('new', 'edit.ts')).toBe('new\n');
    expect(await files.read('new', 'gone.ts')).toBeNull();
    expect(await files.read('old', 'added.ts')).toBeNull();
    expect(await files.read('old', 'same.ts')).toBe('export const formatPrice = 1;\n');
    expect(await files.read('new', 'same.ts')).toBe('export const formatPrice = 1;\n');
    expect(await files.read('new', 'missing.ts')).toBeNull();
  });

  it('searches each side for a whole word', async () => {
    const { repo, changes } = await fixture();
    const files = gitSnapshotFiles(repo.path, changes);
    expect(await files.grep('old', 'formatPrice')).toEqual(['edit.ts', 'gone.ts', 'same.ts']);
    expect(await files.grep('new', 'formatPrice')).toEqual(['added.ts', 'same.ts']);
    expect(await files.grep('new', 'format')).toEqual([]);
  });

  it('reads unchanged files of a local target from its base', async () => {
    const { repo, base, changes } = await fixture();
    // As the extractor reports a `local` target: the head is the working tree.
    const local = { ...changes, baseRevision: base, headRevision: null };
    const files = gitSnapshotFiles(repo.path, local);
    expect(await files.read('new', 'same.ts')).toBe('export const formatPrice = 1;\n');
  });
});

describe('changeSetFiles', () => {
  it('reads changed files only and cannot search', async () => {
    const { changes } = await fixture();
    const files = changeSetFiles(changes);
    expect(await files.read('new', 'added.ts')).toBe('formatPrice()\n');
    expect(await files.read('new', 'same.ts')).toBeNull();
    expect(await files.grep('new', 'formatPrice')).toBeNull();
  });
});
