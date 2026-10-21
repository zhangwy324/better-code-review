// Only tests and configuration change: package.json, tsconfig.json, a CI workflow and a test
// file. The code under test is unchanged, so there are no edges.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const pkg = (version: string, test: string) =>
  lines(
    '{',
    '  "name": "shop",',
    `  "version": "${version}",`,
    '  "type": "module",',
    `  "scripts": { "test": "${test}" },`,
    '  "devDependencies": { "vitest": "^3.0.0" }',
    '}',
  );

const workflow = (node: number) =>
  lines(
    'name: CI',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    `          node-version: ${node}`,
    '      - run: npm ci && npm test',
  );

const base: Files = {
  'package.json': pkg('1.0.0', 'vitest run'),
  'tsconfig.json': TSCONFIG,
  '.github/workflows/ci.yml': workflow(20),
  'src/price.ts': lines(
    'export function formatPrice(amount: number): string {',
    '  return amount.toFixed(2);',
    '}',
  ),
  'src/price.test.ts': lines(
    "import { describe, expect, it } from 'vitest';",
    "import { formatPrice } from './price.ts';",
    '',
    "describe('formatPrice', () => {",
    "  it('keeps two decimals', () => {",
    "    expect(formatPrice(1)).toBe('1.00');",
    '  });',
    '});',
  ),
};

const head: Files = {
  'package.json': pkg('1.0.1', 'vitest run --coverage'),
  'tsconfig.json': TSCONFIG.replace(
    '"strict": true',
    '"strict": true, "noUncheckedIndexedAccess": true',
  ),
  '.github/workflows/ci.yml': workflow(22),
  'src/price.test.ts': lines(
    "import { describe, expect, it } from 'vitest';",
    "import { formatPrice } from './price.ts';",
    '',
    "describe('formatPrice', () => {",
    "  it('keeps two decimals', () => {",
    "    expect(formatPrice(1)).toBe('1.00');",
    '  });',
    '',
    "  it('rounds half up', () => {",
    "    expect(formatPrice(0.125)).toBe('0.13');",
    '  });',
    '});',
  ),
};

export const testsAndConfig: Fixture = {
  name: 'tests-and-config',
  summary: 'Test and configuration edits only, with the code under test unchanged.',
  base,
  head,
  expected: {
    files: [
      'package.json git-only',
      'tsconfig.json git-only',
      '.github/workflows/ci.yml git-only',
      'src/price.test.ts structural test',
    ],
    // The describe block changes too: the blank line before the new test is inside it.
    nodes: [
      'file package.json',
      'file tsconfig.json',
      'file .github/workflows/ci.yml',
      'symbol formatPrice',
      'symbol formatPrice.rounds half up',
    ],
    // The code under test is unchanged, so the test's call is not an edge (D12).
    edges: [],
  },
  // A test group and a configuration group. No code changed, so there is no code group.
  plan: {
    together: [
      ['formatPrice', 'formatPrice.rounds half up'],
      ['package.json', 'tsconfig.json', '.github/workflows/ci.yml'],
    ],
    apart: [
      ['formatPrice', 'formatPrice.rounds half up'],
      ['package.json', 'tsconfig.json', '.github/workflows/ci.yml'],
    ],
  },
  later: [],
};
