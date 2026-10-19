import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DiscoveryContext, type Launch, serverFor } from './servers.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bcr-servers-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, text = ''): void {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

/** A fake npm package: package.json plus its bin scripts. */
function pkg(at: string, name: string, version: string, bin: Record<string, string>): void {
  write(`${at}/package.json`, JSON.stringify({ name, version, bin }));
  for (const script of Object.values(bin)) write(`${at}/${script}`, '');
}

function discover(language: string, opts: Partial<DiscoveryContext> = {}): Launch | string {
  const result = serverFor(language)!.discover({
    root: join(dir, 'project'),
    searchPath: '',
    allowProjectCode: false,
    platform: process.platform,
    ...opts,
  });
  return result.launch ?? result.why;
}

describe('TypeScript discovery', () => {
  it("prefers the project's TypeScript 7 through its native `tsc --lsp`", () => {
    pkg('project/node_modules/typescript', 'typescript', '7.0.2', { tsc: 'bin/tsc' });
    pkg('project/node_modules/typescript-language-server', 'typescript-language-server', '6.0.2', {
      'typescript-language-server': 'lib/cli.mjs',
    });
    const launch = discover('typescript') as Launch;
    expect(launch.name).toBe('tsc --lsp');
    expect(launch.version).toBe('7.0.2');
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([
      join(dir, 'project/node_modules/typescript/bin/tsc'),
      '--lsp',
      '--stdio',
    ]);
    expect(launch.configuration).toMatch(/TypeScript 7\.0\.2 from the project/);
  });

  it("runs typescript-language-server on the project's TypeScript 5.x", () => {
    pkg('project/node_modules/typescript', 'typescript', '5.9.3', { tsc: 'bin/tsc' });
    pkg('project/node_modules/typescript-language-server', 'typescript-language-server', '6.0.2', {
      'typescript-language-server': 'lib/cli.mjs',
    });
    const launch = discover('tsx') as Launch;
    expect(launch.name).toBe('typescript-language-server');
    expect(launch.args.slice(1)).toEqual(['--stdio']);
    expect(launch.initializationOptions).toEqual({
      tsserver: { path: join(dir, 'project/node_modules/typescript/lib') },
    });
    expect(launch.configuration).toMatch(/TypeScript 5\.9\.3 from the project/);
  });

  it('does not use typescript-language-server when only TypeScript 7 is next to it', () => {
    // A global install where `typescript@latest` is 7: tsserver.js does not exist. npm's
    // Windows layout (launcher next to node_modules) is found on every OS.
    pkg('global/node_modules/typescript-language-server', 'typescript-language-server', '6.0.2', {
      'typescript-language-server': 'lib/cli.mjs',
    });
    pkg('global/node_modules/typescript', 'typescript', '7.0.2', { tsc: 'bin/tsc' });
    write(`global/typescript-language-server${process.platform === 'win32' ? '.cmd' : ''}`);
    expect(discover('typescript', { searchPath: join(dir, 'global') })).toMatch(
      /no TypeScript 5\.x\/6\.x/,
    );
  });

  it('reports what is missing', () => {
    expect(discover('typescript')).toMatch(/neither typescript-language-server nor TypeScript 7/);
  });
});

describe('Python discovery', () => {
  it('runs pyright from PATH and adds src to extraPaths for a src layout', () => {
    write(`bin/pyright-langserver${process.platform === 'win32' ? '.cmd' : ''}`);
    write('project/src/mypkg/__init__.py');
    const launch = discover('python', { searchPath: join(dir, 'bin') }) as Launch;
    expect(launch.name).toBe('pyright');
    expect(launch.args.map((a) => a.replaceAll('"', ''))).toEqual(['--stdio']); // quoted for a .cmd
    expect(launch.settings).toEqual({ python: { analysis: { extraPaths: ['src'] } } });
    expect(launch.configuration).toMatch(/extraPaths: src/);
  });

  it('uses a repository virtualenv only with the project-code opt-in', () => {
    pkg('project/node_modules/pyright', 'pyright', '1.1.414', {
      pyright: 'index.js',
      'pyright-langserver': 'langserver.index.js',
    });
    const venv = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    write(`project/${venv}`);
    const without = discover('python') as Launch;
    expect(without.version).toBe('1.1.414');
    expect(without.settings).toEqual({ python: { analysis: {} } });
    expect(without.configuration).toMatch(/virtualenv not used/);
    const withOptIn = discover('python', { allowProjectCode: true }) as Launch;
    expect(withOptIn.settings).toEqual({
      python: { analysis: {}, pythonPath: join(dir, 'project', venv) },
    });
  });

  it('reports pyright missing', () => {
    expect(discover('python')).toBe('pyright not found');
  });
});

describe('servers that run project code', () => {
  it('marks jdtls and rust-analyzer as needing the opt-in', () => {
    expect(serverFor('java')!.runsProjectCode).toMatch(/Gradle/);
    expect(serverFor('rust')!.runsProjectCode).toMatch(/build\.rs/);
    expect(serverFor('typescript')!.runsProjectCode).toBeNull();
    expect(serverFor('python')!.runsProjectCode).toBeNull();
  });
});
