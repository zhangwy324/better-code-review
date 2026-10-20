// Runs the LSP integration suites against pinned language servers (test/lsp-servers/): installs
// each package with `npm ci`, then runs vitest with BCR_LSP_TEST_PATH pointing at them and
// BCR_LSP_REQUIRED set, so a server that failed to install fails the run instead of skipping.
// Usage: npm run test:lsp [-- --no-install] [-- <vitest args>]
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Each directory is one server setup; typescript-language-server needs a TypeScript < 7 next to
// it, so TypeScript 7 gets a directory of its own.
const SETUPS = ['tsserver', 'ts7'];
const REQUIRED = 'typescript:2,python:1';

const args = process.argv.slice(2);
const install = !args.includes('--no-install');
const vitestArgs = args.filter((a) => a !== '--no-install');

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (install) {
  // npm sets npm_execpath when this runs through `npm run`; otherwise fall back to `npm` itself.
  const npm = process.env.npm_execpath;
  for (const setup of SETUPS) {
    const prefix = join('test', 'lsp-servers', setup);
    const npmArgs = ['ci', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts'];
    if (npm) run(process.execPath, [npm, ...npmArgs]);
    else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs);
  }
}

const searchPath = SETUPS.map((s) => join(root, 'test', 'lsp-servers', s, 'node_modules', '.bin'));
run(
  process.execPath,
  [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'integration', ...vitestArgs],
  {
    ...process.env,
    BCR_LSP_TEST_PATH: searchPath.join(delimiter),
    BCR_LSP_REQUIRED: REQUIRED,
  },
);
