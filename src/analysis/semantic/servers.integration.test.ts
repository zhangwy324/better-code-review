// Real language servers on the #3/#4 signature fixture. Each suite runs only when its server is
// installed, so CI without servers skips them. To run them, put the servers on PATH, or list
// directories in BCR_LSP_TEST_PATH (separated like PATH); each directory is tried on its own, so
// typescript-language-server and TS 7 can both be tested in one run, e.g.
//   BCR_LSP_TEST_PATH=/a/node_modules/.bin:/b/node_modules/.bin npx vitest run servers.integration
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ReferencesResult, LspSession } from './session.ts';
import { installedServers } from './lsp-servers.test-helper.ts';

const TS_FILES: Record<string, string> = {
  'tsconfig.json':
    '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext" } }\n',
  'src/price.ts':
    "export function formatPrice(amount: number, currency = 'USD'): string {\n  return `${currency} ${amount.toFixed(2)}`;\n}\n",
  'src/checkout.ts':
    "import { formatPrice } from './price.ts';\n\nexport function checkoutSummary(t: number) {\n  return formatPrice(t, 'EUR');\n}\n",
  'src/email.ts':
    "import {\n  formatPrice,\n} from './price.ts';\n\nexport function emailSummary(t: number) {\n  return formatPrice(t);\n}\n",
  'legacy/price.ts':
    'export function formatPrice(n: number) {\n  return String(n);\n}\n\nexport function legacyLabel() {\n  return formatPrice(1);\n}\n',
  'src/fmt.ts':
    'export class Fmt {\n  formatPrice(n: number) {\n    return String(n);\n  }\n}\n\nexport function viaMethod(f: Fmt) {\n  return f.formatPrice(1);\n}\n',
  'src/reexport.ts': "export { formatPrice as fmt } from './price.ts';\n",
  'src/viaAlias.ts':
    "import { fmt } from './reexport.ts';\n\nexport function aliasCaller() {\n  return fmt(1);\n}\n",
  'src/shapes.ts':
    'export class Shape {\n  area(): number {\n    return 0;\n  }\n}\n\nexport class Square extends Shape {\n  constructor(public side: number) {\n    super();\n  }\n  override area(): number {\n    return this.side ** 2 + super.area();\n  }\n}\n\nexport class Circle extends Shape {\n  override area(): number {\n    return 3;\n  }\n}\n',
  'src/useShapes.ts':
    "import { Circle, Shape, Square } from './shapes.ts';\n\nexport function total(shapes: Shape[]) {\n  return shapes.reduce((n, s) => n + s.area(), 0);\n}\nexport function squareArea(sq: Square) {\n  return sq.area();\n}\nexport function circleArea(c: Circle) {\n  return c.area();\n}\nexport function make(): Square {\n  return new Square(2);\n}\n",
  'src/broken.ts': "import { x } from 'not-a-real-package-xyz';\n\nexport const y = x;\n",
};

const PY_FILES: Record<string, string> = {
  'tax.py': 'def tax(amount, rate=0.1):\n    return amount * rate\n',
  'orders.py': 'from tax import tax\n\n\ndef order_total(a):\n    return a + tax(a)\n',
  'refunds.py': 'import tax as t\n\n\ndef refund(a):\n    return t.tax(a)\n',
  'calc.py':
    'class Calc:\n    def tax(self, a):\n        return a\n\n\ndef use_calc():\n    return Calc().tax(1)\n',
  'shapes.py':
    'class Shape:\n    def area(self) -> float:\n        return 0\n\n\nclass Square(Shape):\n    def __init__(self, side: float):\n        self.side = side\n\n    def area(self) -> float:\n        return self.side**2\n\n\nclass Circle(Shape):\n    def area(self) -> float:\n        return 3\n',
  'use_shapes.py':
    'from shapes import Circle, Shape, Square\n\n\ndef total(shapes: list[Shape]) -> float:\n    return sum(s.area() for s in shapes)\n\n\ndef circle_area(c: Circle) -> float:\n    return c.area()\n\n\ndef make() -> Square:\n    return Square(2)\n\n\ndef check(x: object) -> bool:\n    return isinstance(x, Square)\n',
  'broken.py': 'import not_a_real_module_xyz\n\n\ndef f():\n    return not_a_real_module_xyz\n',
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bcr-lsp-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function sites(result: ReferencesResult): string[] {
  if (result.status !== 'ok') throw new Error(result.reason);
  return result.references.map((r) => `${r.path}:${r.range.startLine}`).sort();
}

const TIMEOUT = 120_000;
const timeouts = { emptyGraceMs: 3000, retryDelayMs: 500 };

const tsServers = installedServers('typescript');
describe.skipIf(tsServers.length === 0)('TypeScript servers', () => {
  for (const { searchPath, launch } of tsServers) {
    describe(launch.configuration, () => {
      let session: LspSession;
      const ts = (
        path: string,
        line: number,
        column: number,
        kind: 'function' | 'method' | 'constructor',
      ) => ({
        language: 'typescript',
        path,
        line,
        column,
        kind,
      });

      // Started before, and closed after, every test, so one test can be run on its own with -t.
      beforeAll(async () => {
        session = await LspSession.start(fixture(TS_FILES), ['typescript', 'tsx'], {
          searchPath,
          timeouts,
        });
      }, TIMEOUT);
      afterAll(() => session?.close());

      it(
        'starts and reports which TypeScript it uses',
        () => {
          const [cap] = session.capabilities();
          expect(cap).toMatchObject({ status: 'ok', server: { name: launch.name } });
          expect(cap!.server!.configuration).toMatch(/TypeScript \d/);
        },
        TIMEOUT,
      );

      it(
        'finds the callers of formatPrice, without imports, collisions or the alias name',
        async () => {
          // The same answer from tsserver and TS 7 after normalisation.
          expect(sites(await session.references(ts('src/price.ts', 1, 17, 'function')))).toEqual([
            'src/checkout.ts:4',
            'src/email.ts:6',
            'src/reexport.ts:1',
            'src/viaAlias.ts:4',
          ]);
        },
        TIMEOUT,
      );

      it(
        'queries a constructor through its class and keeps only `new` calls',
        async () => {
          const result = await session.references(ts('src/shapes.ts', 7, 14, 'constructor'));
          expect(sites(result)).toEqual(['src/useShapes.ts:13']);
        },
        TIMEOUT,
      );

      it(
        'filters an override by receiver type',
        async () => {
          const result = await session.references({
            ...ts('src/shapes.ts', 11, 12, 'method'),
            baseMethods: [{ path: 'src/shapes.ts', line: 2, column: 3 }],
            receiverTypes: ['Square', 'Shape'],
          });
          // s.area() (Shape) and sq.area() (Square); not c.area() (Circle) or declarations.
          expect(sites(result)).toEqual(['src/useShapes.ts:4', 'src/useShapes.ts:7']);
          if (result.status === 'ok') {
            // super.area() inside Square calls Shape.area: left undecided, not confirmed.
            expect(result.unresolved.map((r) => r.path)).toEqual(['src/shapes.ts']);
          }
        },
        TIMEOUT,
      );

      it(
        'checks project health from unresolved imports',
        async () => {
          expect(await session.projectHealth('typescript', ['src/checkout.ts'])).toMatchObject({
            healthy: true,
          });
          const broken = await session.projectHealth('typescript', ['src/broken.ts']);
          expect(broken).toMatchObject({ healthy: false, imports: 1 });
          expect(session.capabilities()[0]!.status).toBe('unhealthy');
        },
        TIMEOUT,
      );
    });
  }
});

const pyServers = installedServers('python');
describe.skipIf(pyServers.length === 0)('Python servers', () => {
  for (const { searchPath, launch } of pyServers) {
    describe(launch.name, () => {
      let session: LspSession;
      const py = (
        path: string,
        line: number,
        column: number,
        kind: 'function' | 'method' | 'constructor',
      ) => ({
        language: 'python',
        path,
        line,
        column,
        kind,
      });

      beforeAll(async () => {
        session = await LspSession.start(fixture(PY_FILES), ['python'], { searchPath, timeouts });
      }, TIMEOUT);
      afterAll(() => session?.close());

      it(
        'starts',
        () => {
          expect(session.capabilities()[0]).toMatchObject({ status: 'ok' });
        },
        TIMEOUT,
      );

      it(
        'finds the callers of tax, including the module alias, and rejects Calc.tax',
        async () => {
          expect(sites(await session.references(py('tax.py', 1, 5, 'function')))).toEqual([
            'orders.py:5',
            'refunds.py:5',
          ]);
        },
        TIMEOUT,
      );

      it(
        'queries __init__ through the class and keeps only calls',
        async () => {
          const result = await session.references(py('shapes.py', 6, 7, 'constructor'));
          expect(sites(result)).toEqual(['use_shapes.py:13']); // not the isinstance check
        },
        TIMEOUT,
      );

      it(
        'adds calls through the base method whose receiver can reach the override',
        async () => {
          const result = await session.references({
            ...py('shapes.py', 10, 9, 'method'),
            baseMethods: [{ path: 'shapes.py', line: 2, column: 9 }],
            receiverTypes: ['Square', 'Shape'],
          });
          // pyright returns nothing for the override itself (#42); s.area() comes via Shape.area,
          // c.area() (Circle) is dropped.
          expect(result).toMatchObject({
            status: 'ok',
            references: [{ path: 'use_shapes.py', via: 'base-method' }],
          });
        },
        TIMEOUT,
      );

      it(
        'checks project health from unresolved imports',
        async () => {
          expect(await session.projectHealth('python', ['orders.py'])).toMatchObject({
            healthy: true,
          });
          expect(await session.projectHealth('python', ['broken.py'])).toMatchObject({
            healthy: false,
            imports: 1,
          });
        },
        TIMEOUT,
      );
    });
  }
});
