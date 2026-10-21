// One changed function and ten changed callers: `parseDate(text)` gains `zone`, and every
// caller, one per file, passes it.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const CALLERS = Array.from({ length: 10 }, (_, i) => `report${i + 1}`);

const caller = (name: string, call: string) =>
  lines(
    "import { parseDate } from '../dates.ts';",
    '',
    `export function ${name}(text: string): number {`,
    `  return ${call}.getTime();`,
    '}',
  );

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/dates.ts': lines(
    'export function parseDate(text: string): Date {',
    '  return new Date(text);',
    '}',
  ),
  ...Object.fromEntries(CALLERS.map((n) => [`src/reports/${n}.ts`, caller(n, 'parseDate(text)')])),
};

const head: Files = {
  'src/dates.ts': lines(
    'export function parseDate(text: string, zone: string): Date {',
    "  return new Date(`${text}${zone === 'UTC' ? 'Z' : ''}`);",
    '}',
  ),
  ...Object.fromEntries(
    CALLERS.map((n) => [`src/reports/${n}.ts`, caller(n, "parseDate(text, 'UTC')")]),
  ),
};

export const tenCallers: Fixture = {
  name: 'ten-callers',
  summary: 'One changed function and ten changed callers, one per file.',
  base,
  head,
  expected: {
    files: ['src/dates.ts structural', ...CALLERS.map((n) => `src/reports/${n}.ts structural`)],
    nodes: ['symbol parseDate', ...CALLERS.map((n) => `symbol ${n}`)],
    // parseDate has one definition, so each plain call is accepted as possible.
    edges: CALLERS.map((n) => `${n} calls parseDate (both)`),
  },
  plan: { order: [[['parseDate'], CALLERS]] },
  later: [],
};
