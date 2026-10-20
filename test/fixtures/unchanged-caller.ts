// A changed function whose caller is affected but unchanged: `findUser` now throws instead of
// returning undefined, a contract change its signature doesn't show, and `greeting` still checks
// for undefined. Under D12 the caller is not analysed, so the graph is the changed function alone.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const base: Files = {
  'tsconfig.json': TSCONFIG,
  'src/users.ts': lines(
    "const USERS = new Map([['1', 'Ada']]);",
    '',
    'export function findUser(id: string): string | undefined {',
    '  return USERS.get(id);',
    '}',
  ),
  'src/greeting.ts': lines(
    "import { findUser } from './users.ts';",
    '',
    'export function greeting(id: string): string {',
    '  const name = findUser(id);',
    "  return name === undefined ? 'Hello, stranger' : `Hello, ${name}`;",
    '}',
  ),
};

const head: Files = {
  'src/users.ts': lines(
    "const USERS = new Map([['1', 'Ada']]);",
    '',
    'export function findUser(id: string): string | undefined {',
    '  const name = USERS.get(id);',
    '  if (name === undefined) throw new Error(`no user ${id}`);',
    '  return name;',
    '}',
  ),
};

export const unchangedCaller: Fixture = {
  name: 'unchanged-caller',
  summary: 'A contract change with an affected but unchanged caller, which v0.1 does not show.',
  base,
  head,
  expected: {
    files: ['src/users.ts structural'],
    // greeting is unchanged, so it is not a node and has no edge (D12).
    nodes: ['symbol findUser'],
    edges: [],
  },
  later: [
    'Post-MVP (#2): greeting is found as an unchanged but affected caller of findUser.',
    'M3: the artifact says that unchanged callers are not analysed (D12).',
  ],
};
