import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkoutRevision } from './checkout.ts';
import { TestRepo } from './test-repo.test-helper.ts';

const out = mkdtempSync(join(tmpdir(), 'bcr-checkout-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('checkoutRevision', () => {
  it("writes a revision's files and leaves the index and worktrees alone", async () => {
    const repo = new TestRepo();
    // checkoutRevision runs with the user's config; Git for Windows sets core.autocrlf in it.
    repo.git('config', 'core.autocrlf', 'false');
    const base = repo.commit([], { 'a.ts': 'old\n', 'src/b.py': 'b\n' });
    const head = repo.commit([base], { 'a.ts': 'new\n', 'src/b.py': null });
    const index = repo.git('ls-files', '--stage');

    const dir = join(out, 'base');
    await checkoutRevision(repo.path, base, dir);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('old\n');
    expect(readFileSync(join(dir, 'src/b.py'), 'utf8')).toBe('b\n');

    await checkoutRevision(repo.path, head, join(out, 'head'));
    expect(existsSync(join(out, 'head', 'src/b.py'))).toBe(false);

    expect(repo.git('ls-files', '--stage')).toBe(index);
    expect(repo.git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});
