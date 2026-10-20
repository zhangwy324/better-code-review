// A method that overrides a base method changes, and its changed caller reaches it only through
// the base type: `s.area()` with `s: Shape` can run `Square.area`. pyright's references to the
// override miss such calls (#42), so the analyzer asks about the base method too (#81). Two
// fixtures, TypeScript and Python, so each language-server setup runs the one it can serve.
import { type Files, type Fixture, lines, TSCONFIG } from './fixture.ts';

const shapes = (area: string) =>
  lines(
    'export class Shape {',
    '  area(): number {',
    '    return 0;',
    '  }',
    '}',
    '',
    'export class Square extends Shape {',
    '  side = 1;',
    '',
    '  area(): number {',
    `    return ${area};`,
    '  }',
    '}',
  );
const report = (call: string) =>
  lines(
    "import type { Shape } from './shapes.ts';",
    '',
    'export function label(s: Shape): string {',
    `  return 'area ' + ${call};`,
    '}',
  );

export const overrideDispatch: Fixture = {
  name: 'override-dispatch',
  summary: 'A changed override is called only through its base type.',
  base: {
    'tsconfig.json': TSCONFIG,
    'src/shapes.ts': shapes('this.side * this.side'),
    'src/report.ts': report('s.area()'),
  },
  head: {
    'src/shapes.ts': shapes('this.side ** 2'),
    'src/report.ts': report('s.area().toFixed(2)'),
  },
  expected: {
    files: ['src/shapes.ts structural', 'src/report.ts structural'],
    // Only the method's body changes, so the class does not.
    nodes: ['symbol Square.area', 'symbol label'],
    // A receiver call: only types settle it.
    edges: ['label calls Square.area (both)'],
  },
  // Both TypeScript servers return the call among the override's own references, and
  // `baseMethods` (Shape.area) returns it too; its receiver's type, Shape, is a base of Square.
  later: [],
};

const accounts = (interest: string) =>
  lines(
    'class Account:',
    '    def interest(self):',
    '        return 0',
    '',
    '',
    'class Savings(Account):',
    '    rate = 0.02',
    '',
    '    def interest(self):',
    `        return ${interest}`,
  );
const summarise = (call: string) =>
  lines(
    'from accounts import Account',
    '',
    '',
    'def summarise(a: Account) -> str:',
    `    return "interest " + ${call}`,
  );

const pythonBase: Files = {
  'accounts.py': accounts('100 * self.rate'),
  'report.py': summarise('str(a.interest())'),
};

export const overrideDispatchPython: Fixture = {
  name: 'override-dispatch-python',
  summary: 'A changed Python override is called only through its base type.',
  base: pythonBase,
  head: {
    'accounts.py': accounts('round(100 * self.rate, 2)'),
    'report.py': summarise('format(a.interest(), ".2f")'),
  },
  expected: {
    files: ['accounts.py structural', 'report.py structural'],
    nodes: ['symbol Savings.interest', 'symbol summarise'],
    edges: ['summarise calls Savings.interest (both)'],
  },
  // pyright returns nothing for the override itself (#42). The call comes from the base method
  // Account.interest (`baseMethods`), and its receiver's type, Account, is a base of Savings.
  later: [],
};
