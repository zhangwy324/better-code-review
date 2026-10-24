import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees are full checkouts of other branches; their tests are not this branch's.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
    // Fixture repositories spawn many git processes, which take several seconds on Windows CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Show console output from passing tests too, so replay.test.ts's out-of-date recordings are
    // listed (#131). Vitest hides it by default.
    silent: false,
  },
});
