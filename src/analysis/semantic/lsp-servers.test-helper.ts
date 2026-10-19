// Finds the language servers the integration tests can run: on PATH, or in the directories
// listed in BCR_LSP_TEST_PATH (separated like PATH), each tried on its own.
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
  return [...found.values()];
}
