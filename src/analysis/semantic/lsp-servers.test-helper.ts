// Finds the language servers the integration tests can run: on PATH, or in the directories
// listed in BCR_LSP_TEST_PATH (separated like PATH), each tried on its own.
//
// Suites skip a language with no server, so CI without servers passes. Where servers are meant
// to be installed (the `lsp` CI job, `npm run test:lsp`), BCR_LSP_REQUIRED turns a missing one
// into a failure instead of a silent skip: `typescript:2,python` requires two distinct TypeScript
// servers and one Python server (the count defaults to 1).
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { type Launch, serverFor } from './servers.ts';

/** Every distinct installed server for a language, one per search path, BCR_LSP_TEST_PATH first. */
export function installedServers(language: string): { searchPath: string; launch: Launch }[] {
  const paths = [
    ...(process.env.BCR_LSP_TEST_PATH ?? '').split(delimiter).filter(Boolean),
    process.env.PATH ?? '',
  ];
  const found = new Map<string, { searchPath: string; launch: Launch }>();
  for (const searchPath of paths) {
    const { launch } = serverFor(language)!.discover({
      root: tmpdir(),
      searchPath,
      allowProjectCode: false,
      untrustedPackages: null,
      platform: process.platform,
    });
    const key = launch ? [launch.command, ...launch.args].join(' ') : '';
    if (launch && !found.has(key)) found.set(key, { searchPath, launch });
  }
  const required = requiredCount(language);
  if (found.size < required) {
    throw new Error(
      `BCR_LSP_REQUIRED asks for ${required} ${language} server(s), but ${found.size} were found ` +
        `(BCR_LSP_TEST_PATH=${process.env.BCR_LSP_TEST_PATH ?? ''}). Run \`npm run test:lsp\`.`,
    );
  }
  return [...found.values()];
}

function requiredCount(language: string): number {
  for (const entry of (process.env.BCR_LSP_REQUIRED ?? '').split(',')) {
    const [name, count = '1'] = entry.trim().split(':');
    if (name === language) return Number(count);
  }
  return 0;
}
