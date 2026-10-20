// Builds a portfolio fixture (test/fixtures/README.md) as a real repository, for trying the tool
// by hand or with a language server. The working tree holds the head; `main` is the head commit
// and the tag `base` its parent.
// Usage: npm run fixtures -- --list
//        npm run fixtures -- <name> <dir>
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIXTURES } from '../test/fixtures/index.ts';
import { buildFixtureRepo } from '../test/fixtures/repo.ts';

const [name, dir] = process.argv.slice(2);

if (name === '--list' || name === undefined) {
  const width = Math.max(...FIXTURES.map((f) => f.name.length));
  for (const f of FIXTURES) console.log(`${f.name.padEnd(width)}  ${f.summary}`);
  if (name === undefined) {
    console.error('\nUsage: npm run fixtures -- <name> <dir>');
    process.exitCode = 2;
  }
} else {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (fixture === undefined || dir === undefined) {
    console.error(
      fixture === undefined
        ? `Unknown fixture ${name}; npm run fixtures -- --list shows them.`
        : 'Usage: npm run fixtures -- <name> <dir>',
    );
    process.exitCode = 2;
  } else if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(`${dir} is not empty.`);
    process.exitCode = 1;
  } else {
    buildFixtureRepo(dir, fixture, { checkout: true });
    console.log(`Built ${name} in ${resolve(dir)}. Try:`);
    console.log(`  cd ${dir} && better-code-review generate --commit main`);
  }
}
