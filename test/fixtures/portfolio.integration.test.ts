// Every portfolio fixture (README.md) through `generate` with real language servers, against its
// expected facts and `withLsp` (#21). Runs once per installed TypeScript server; a fixture with
// Python files needs a Python server in the same search path. `npm run test:lsp` installs them;
// without them the suite skips.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installedServers } from '../../src/analysis/semantic/lsp-servers.test-helper.ts';
import { generate } from '../../src/cli/generate.ts';
import { facts } from './facts.ts';
import type { Fixture } from './fixture.ts';
import { FIXTURES } from './index.ts';
import { buildFixtureRepo } from './repo.ts';

const root = mkdtempSync(join(tmpdir(), 'bcr-fixtures-lsp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const python = new Set(installedServers('python').map((s) => s.searchPath));
const setups = installedServers('typescript').map((s) => ({
  name: `${s.launch.name} ${s.launch.version ?? ''}`.trim(),
  searchPath: s.searchPath,
}));

const needsPython = (fixture: Fixture) =>
  Object.keys({ ...fixture.base, ...fixture.head }).some((p) => p.endsWith('.py'));

// With no server, one skipped placeholder: a file with no suite at all fails.
const cases = setups.length > 0 ? setups : [{ name: 'no TypeScript server', searchPath: '' }];

describe.skipIf(setups.length === 0).each(cases)('$name', ({ searchPath }) => {
  describe.each(FIXTURES)('fixture $name', (fixture) => {
    it.skipIf(needsPython(fixture) && !python.has(searchPath))(
      'matches its expected facts with language servers',
      async () => {
        const dir = mkdtempSync(join(root, `${fixture.name}-`));
        const { head } = buildFixtureRepo(join(dir, 'repo'), fixture);
        const { changeSet, graph } = await generate(
          {
            repositoryPath: join(dir, 'repo'),
            target: { kind: 'commit', commit: head },
            outputDirectory: join(dir, 'out'),
            analysis: { useLsp: true, allowProjectCodeExecution: false },
          },
          { lsp: { searchPath, timeouts: { emptyGraceMs: 3000, retryDelayMs: 500 } } },
        );

        expect(graph.languages.filter((l) => l.status !== 'ok')).toEqual([]);

        const { expected, withLsp = {} } = fixture;
        const rejected = new Set(withLsp.rejected);
        const possible = new Set(withLsp.possible);
        const sorted = (l: string[] = []) => [...l].sort();
        expect(facts(changeSet, graph, { provenance: true })).toEqual({
          files: sorted(expected.files.map((f) => f.replace(' structural', ' semantic'))),
          nodes: sorted(expected.nodes),
          edges: sorted(
            expected.edges
              .filter((e) => !rejected.has(e))
              .map((e) => `${e} ${possible.has(e) ? 'possible' : 'verified'}`),
          ),
          caps: sorted(expected.caps),
        });
      },
      180_000,
    );
  });
});
