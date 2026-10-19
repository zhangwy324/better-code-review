import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees are full checkouts of other branches; their tests are not this branch's.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
});
