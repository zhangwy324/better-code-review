#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const USAGE = `Usage: better-code-review [--help] [--version]

Commands are not implemented yet (see the MVP spec, docs/mvp-spec.md).
`;

export function version(): string {
  // Same relative path from src/cli/ and dist/cli/.
  const pkgUrl = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string };
  return pkg.version;
}

export function run(argv: string[]): RunResult {
  let values: { help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
    }));
  } catch (err) {
    return { exitCode: 2, stdout: '', stderr: `${(err as Error).message}\n\n${USAGE}` };
  }

  if (values.version) return { exitCode: 0, stdout: `${version()}\n`, stderr: '' };
  return { exitCode: 0, stdout: USAGE, stderr: '' };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
