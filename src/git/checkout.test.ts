import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('runs none of the repository hooks', async () => {
    const repo = new TestRepo();
    repo.git('config', 'core.autocrlf', 'false');
    const head = repo.commit([], { 'a.ts': 'a\n' });
    // Git runs post-index-change for read-tree, even into another index file.
    const marker = join(out, 'hook-ran');
    for (const hook of ['post-index-change', 'post-checkout']) {
      writeFileSync(
        join(repo.path, '.git', 'hooks', hook),
        `#!/bin/sh\necho ${hook} >> '${marker}'\n`,
        {
          mode: 0o755,
        },
      );
    }
    await checkoutRevision(repo.path, head, join(out, 'hooks'));
    expect(readFileSync(join(out, 'hooks', 'a.ts'), 'utf8')).toBe('a\n');
    expect(existsSync(marker)).toBe(false);
  });
});
