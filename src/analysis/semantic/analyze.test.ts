import { describe, expect, it } from 'vitest';
import type { ReferenceSite, ReferencesResult, ReferenceTarget } from './session.ts';
import type { ReferenceProvider } from './analyze.ts';
import {
  analyse,
  SIGNATURE_BASE,
  SIGNATURE_HEAD,
  summary,
  type Files,
} from './fixture.test-helper.ts';

// Fixtures are real two-commit repositories run through the Git extractor and the structural
// analyzer, as in src/analysis/structural/analyze.test.ts. Unchanged files are read from Git.
const lines = (...l: string[]) => `${l.join('\n')}\n`;
const newSide = (s: string[]) => s.filter((l) => l.startsWith('new '));
const oldSide = (s: string[]) => s.filter((l) => l.startsWith('old '));

const PRICE_BASE = lines(
  'export function formatPrice(amount: number): string {',
  '  return String(amount);',
  '}',
);
const PRICE_HEAD = lines(
  'export function formatPrice(amount: number, currency: string): string {',
  '  return currency + amount;',
  '}',
);

describe('analyzeSemantics on the signature fixture, without LSP (#17 acceptance)', () => {
  it('finds the changed callers, not emailSummary, and leaves the collisions possible at best', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    expect(newSide(summary(result))).toEqual([
      'new calls checkoutSummary -> formatPrice @src/checkout.ts:4 text-search:candidate import-resolution:confirmed',
      // Fmt.formatPrice through a receiver: only types settle it (#42), so it stays possible.
      'new calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate',
      'new calls invoiceSummary -> formatPrice @src/invoice.ts:4 text-search:candidate import-resolution:confirmed',
      // The other formatPrice, imported from src/legacy/price.ts.
      'new calls legacyLabel -> formatPrice @src/legacyLabel.ts:4 text-search:candidate import-resolution:rejected',
      'new calls receiptSummary -> formatPrice @src/receipt.ts:4 text-search:candidate import-resolution:confirmed',
      // Only through `export { formatPrice as fmt }` in the unchanged src/reexport.ts.
      'new calls aliasCaller -> formatPrice @src/viaAlias.ts:4 text-search:candidate import-resolution:confirmed',
      'new calls use_calc -> tax @calc.py:7 text-search:candidate',
      'new calls order_total -> tax @orders.py:5 text-search:candidate import-resolution:confirmed',
      // Module alias: `import tax as t` + `t.tax(…)`.
      'new calls refund -> tax @refunds.py:5 text-search:candidate import-resolution:confirmed',
    ]);
    const evidence = result.evidence;
    expect(summary(result).join('\n')).not.toContain('emailSummary');
    expect(evidence.records.filter((r) => r.method === 'lsp')).toEqual([]);
    expect(evidence.caps).toEqual([]);
    expect(evidence.languages).toEqual([
      expect.objectContaining({ language: 'python', status: 'disabled', server: null }),
      expect.objectContaining({ language: 'typescript', status: 'disabled', server: null }),
    ]);
    const alias = evidence.records.find((r) => r.location.path === 'src/viaAlias.ts')!;
    expect(alias).toMatchObject({
      relation: 'calls',
      location: {
        side: 'new',
        range: { startLine: 4, startColumn: 10, endLine: 4, endColumn: 13 },
      },
      detail: 'call; through the alias fmt',
    });
  });

  it('searches the old side too, so removed calls are found', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD);
    // Every caller called formatPrice before the change as well.
    expect(oldSide(summary(result))).toHaveLength(9);
    const removed = await analyse(
      {
        'src/price.ts': PRICE_BASE,
        'src/total.ts': lines(
          "import { formatPrice } from './price';",
          'export function total(n: number) {',
          '  return formatPrice(n);',
          '}',
        ),
      },
      {
        'src/price.ts': PRICE_HEAD,
        'src/total.ts': lines(
          "import { formatPrice } from './price';",
          'export function total(n: number) {',
          '  return String(n);',
          '}',
        ),
      },
    );
    // formatPrice has one definition here, so the plain call is accepted as is.
    expect(summary(removed)).toEqual([
      'old calls total -> formatPrice @src/total.ts:3 text-search:candidate',
    ]);
  });

  it('gives identical IDs on two runs of the same snapshot', async () => {
    const [a, b] = await Promise.all([
      analyse(SIGNATURE_BASE, SIGNATURE_HEAD),
      analyse(SIGNATURE_BASE, SIGNATURE_HEAD),
    ]);
    expect(a.evidence.records.map((r) => r.id)).toEqual(b.evidence.records.map((r) => r.id));
    expect(new Set(a.evidence.records.map((r) => r.id)).size).toBe(a.evidence.records.length);
  });
});

describe('analyzeSemantics: the tree-sitter filter', () => {
  it('skips comments, strings, declarations, keys and imports, and hits in unchanged code', async () => {
    const result = await analyse(
      {
        'src/price.ts': PRICE_BASE,
        'src/use.ts': lines(
          "import { formatPrice } from './price';",
          '',
          'export function unchanged() {',
          '  return formatPrice(1);',
          '}',
          '',
          'export function changed(formatPrice2: number) {',
          '  // formatPrice is called below',
          "  const label = 'formatPrice';",
          '  const o = { formatPrice: 1 };',
          '  return o;',
          '}',
          '',
          'export const TOP = 1;',
        ),
      },
      {
        'src/price.ts': PRICE_HEAD,
        'src/use.ts': lines(
          "import { formatPrice } from './price';",
          '',
          'export function unchanged() {',
          '  return formatPrice(1);',
          '}',
          '',
          'export function changed(formatPrice2: number) {',
          '  // formatPrice is called below',
          "  const label = 'formatPrice';",
          '  const o = { formatPrice: 2 };',
          '  return o;',
          '}',
          '',
          "export const TOP = formatPrice(1, 'EUR');",
        ),
      },
    );
    // Only the top-level call, which belongs to the changed module entity (D2).
    expect(newSide(summary(result))).toEqual([
      'new calls <module src/use.ts> -> formatPrice @src/use.ts:14 text-search:candidate',
    ]);
  });

  it('relates a changed class to its uses: references and base-class lists', async () => {
    const result = await analyse(
      {
        'src/shape.ts': lines(
          'export class Shape {',
          '  area(): number {',
          '    return 0;',
          '  }',
          '}',
        ),
        'src/square.ts': lines(
          "import { Shape } from './shape';",
          'export class Square extends Shape {',
          '  side = 1;',
          '}',
          'export function describe(s: Shape) {',
          '  return s.area();',
          '}',
        ),
      },
      {
        'src/shape.ts': lines(
          'export class Shape {',
          '  area(): number {',
          '    return 1;',
          '  }',
          '}',
        ),
        'src/square.ts': lines(
          "import { Shape } from './shape';",
          'export class Square extends Shape {',
          '  side = 2;',
          '}',
          'export function describe(s: Shape) {',
          '  return String(s.area());',
          '}',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      'new calls describe -> Shape.area @src/square.ts:6 text-search:candidate',
    ]);
    const classChange = await analyse(
      {
        'src/shape.ts': lines('export class Shape {', '  n = 0;', '}'),
        'src/square.ts': lines(
          "import { Shape } from './shape';",
          'export class Square extends Shape {',
          '  side = 1;',
          '}',
          'export function describe(s: Shape) {',
          '  return s;',
          '}',
        ),
      },
      {
        'src/shape.ts': lines('export class Shape {', '  n = 1;', '}'),
        'src/square.ts': lines(
          "import { Shape } from './shape';",
          'export class Square extends Shape {',
          '  side = 2;',
          '}',
          'export function describe(s: Shape) {',
          '  return s ?? null;',
          '}',
        ),
      },
    );
    expect(newSide(summary(classChange))).toEqual([
      'new implements Square -> Shape @src/square.ts:2 text-search:candidate import-resolution:confirmed',
      'new references describe -> Shape @src/square.ts:5 text-search:candidate import-resolution:confirmed',
    ]);
  });
});

describe('analyzeSemantics: deciding candidates', () => {
  it('accepts a plain call of a name with one definition as is (unambiguous rule)', async () => {
    const result = await analyse(
      {
        'src/round.ts': lines('export function roundCents(n: number) {', '  return n;', '}'),
        'src/total.ts': lines(
          "import { roundCents } from './round';",
          'export function total(n: number) {',
          '  return roundCents(n);',
          '}',
        ),
      },
      {
        'src/round.ts': lines(
          'export function roundCents(n: number) {',
          '  return Math.round(n);',
          '}',
        ),
        'src/total.ts': lines(
          "import { roundCents } from './round';",
          'export function total(n: number) {',
          '  return roundCents(n) + 0;',
          '}',
        ),
      },
    );
    const records = result.evidence.records.filter((r) => r.location.side === 'new');
    expect(records).toMatchObject([
      { method: 'text-search', detail: 'call; unambiguous: one definition, plain call' },
    ]);
  });

  it('follows re-exports up to three levels, and no further', async () => {
    const chain = (levels: number): Files => {
      // A second, unchanged definition, so the unambiguous rule does not apply.
      const files: Files = {
        'src/price.ts': PRICE_BASE,
        'src/other.ts': lines('export function formatPrice() {', '  return 1;', '}'),
      };
      let from = './price';
      for (let i = 1; i <= levels; i++) {
        files[`src/r${i}.ts`] = `export { formatPrice } from '${from}';\n`;
        from = `./r${i}`;
      }
      files['src/use.ts'] = lines(
        `import { formatPrice } from '${from}';`,
        'export function use() {',
        '  return formatPrice(1);',
        '}',
      );
      return files;
    };
    const head = (base: Files): Files => ({
      'src/price.ts': PRICE_HEAD,
      'src/use.ts': base['src/use.ts']!.replace('formatPrice(1)', "formatPrice(1, 'EUR')"),
    });
    const three = chain(3);
    expect(newSide(summary(await analyse(three, head(three))))).toEqual([
      'new calls use -> formatPrice @src/use.ts:3 text-search:candidate import-resolution:confirmed',
    ]);
    const four = chain(4);
    expect(newSide(summary(await analyse(four, head(four))))).toEqual([
      'new calls use -> formatPrice @src/use.ts:3 text-search:candidate',
    ]);
  });

  it('rejects a bare name that is neither imported nor defined, and keeps what it cannot decide', async () => {
    const result = await analyse(
      {
        'src/price.ts': PRICE_BASE,
        'src/other.ts': lines('export function formatPrice() {', '  return 1;', '}'),
        'src/a.ts': lines(
          'export function a(formatPrice: () => string) {',
          '  return formatPrice();',
          '}',
        ),
        'src/b.cjs': lines(
          "const { formatPrice } = require('./price');",
          'function b() {',
          '  return formatPrice(1);',
          '}',
        ),
      },
      {
        'src/price.ts': PRICE_HEAD,
        'src/a.ts': lines(
          'export function a(formatPrice: () => string) {',
          '  return formatPrice() + 1;',
          '}',
        ),
        'src/b.cjs': lines(
          "const { formatPrice } = require('./price');",
          'function b() {',
          "  return formatPrice(1, 'EUR');",
          '}',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      // The parameter `formatPrice`: not the import, since there is none (#42).
      'new calls a -> formatPrice @src/a.ts:2 text-search:candidate import-resolution:rejected',
      // CommonJS `require` is not modelled: unknown, not "no".
      'new calls b -> formatPrice @src/b.cjs:3 text-search:candidate',
    ]);
  });

  it('resolves Python packages, `src/` layouts and relative imports', async () => {
    const result = await analyse(
      {
        'src/shop/__init__.py': '',
        'src/shop/api.py': 'from .tax import tax\n',
        'src/shop/tax.py': lines('def tax(amount):', '    return amount'),
        'src/shop/orders.py': lines(
          'from . import tax as taxes',
          '',
          '',
          'def total(a):',
          '    return taxes.tax(a)',
        ),
        'src/shop/refunds.py': lines(
          'from shop.api import tax',
          '',
          '',
          'def refund(a):',
          '    return tax(a)',
        ),
        'other.py': lines('def tax(a):', '    return a'),
      },
      {
        'src/shop/tax.py': lines('def tax(amount, rate=0.1):', '    return amount * rate'),
        'src/shop/orders.py': lines(
          'from . import tax as taxes',
          '',
          '',
          'def total(a):',
          '    return taxes.tax(a, 1)',
        ),
        'src/shop/refunds.py': lines(
          'from shop.api import tax',
          '',
          '',
          'def refund(a):',
          '    return tax(a, 1)',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      // `from . import tax` is the submodule: the package defines no `tax`.
      'new calls total -> tax @src/shop/orders.py:5 text-search:candidate import-resolution:confirmed',
      // Through `from .tax import tax` in shop/api.py, under the `src/` root.
      'new calls refund -> tax @src/shop/refunds.py:5 text-search:candidate import-resolution:confirmed',
    ]);
  });

  it('resolves Java class names from imports and the package', async () => {
    const java = (body: string) => lines('package shop;', '', body);
    const result = await analyse(
      {
        'src/main/java/shop/Price.java': java('public class Price {\n  int cents = 0;\n}'),
        'src/main/java/legacy/Price.java': lines('package legacy;', '', 'public class Price {}'),
        'src/main/java/shop/Cart.java': java(
          'class Cart {\n  Object make() { return new Price(); }\n}',
        ),
        'src/main/java/shop/Old.java': lines(
          'package shop;',
          'import legacy.Price;',
          'class Old {',
          '  Object make() { return new Price(); }',
          '}',
        ),
      },
      {
        'src/main/java/shop/Price.java': java('public class Price {\n  int cents = 1;\n}'),
        'src/main/java/shop/Cart.java': java(
          'class Cart {\n  Object make() { return new Price(/* new */); }\n}',
        ),
        'src/main/java/shop/Old.java': lines(
          'package shop;',
          'import legacy.Price;',
          'class Old {',
          '  Object make() { return new Price(/* new */); }',
          '}',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      'new references Cart.make -> Price @src/main/java/shop/Cart.java:4 text-search:candidate import-resolution:confirmed',
      'new references Old.make -> Price @src/main/java/shop/Old.java:4 text-search:candidate import-resolution:rejected',
    ]);
  });
});

describe('analyzeSemantics: overloads', () => {
  it('treats an overload set as one target, shared by every call (#42)', async () => {
    const price = (body: string) =>
      lines(
        'export function format(n: number): string;',
        'export function format(s: string): string;',
        'export function format(x: unknown): string {',
        `  return ${body};`,
        '}',
      );
    const use = (arg: string) =>
      lines(
        "import { format } from './price';",
        'export function both() {',
        `  return format(1) + format('${arg}');`,
        '}',
      );
    const result = await analyse(
      { 'src/price.ts': price('String(x)'), 'src/use.ts': use('a') },
      { 'src/price.ts': price('`${x}`'), 'src/use.ts': use('b') },
    );
    const targets = new Set(result.evidence.records.map((r) => r.targetEntityId));
    expect(targets.size).toBe(1);
    expect(newSide(summary(result))).toEqual([
      'new calls both -> format @src/use.ts:3 text-search:candidate text-search:candidate',
    ]);
  });
});

describe('analyzeSemantics: constructors', () => {
  it('counts only call sites, and finds super(…) chaining', async () => {
    const result = await analyse(
      {
        'src/shape.ts': lines(
          'export class Shape {',
          '  constructor(public n: number) {}',
          '}',
          'export class Square extends Shape {',
          '  constructor() {',
          '    super(1);',
          '  }',
          '}',
          'export function make(s: Shape): Shape {',
          '  return new Shape(1);',
          '}',
        ),
      },
      {
        'src/shape.ts': lines(
          'export class Shape {',
          '  constructor(public n: number, public m = 0) {}',
          '}',
          'export class Square extends Shape {',
          '  constructor() {',
          '    super(2);',
          '  }',
          '}',
          'export function make(s: Shape): Shape {',
          '  return new Shape(2);',
          '}',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      'new calls Square.constructor -> Shape.constructor @src/shape.ts:6 text-search:candidate',
      // `s: Shape` and the return type are not calls of the constructor.
      'new calls make -> Shape.constructor @src/shape.ts:10 text-search:candidate',
    ]);
  });

  it('finds Java constructor chaining in the same class and in subclasses', async () => {
    const base = lines(
      'class A {',
      '  A() { this(1); }',
      '  A(int x) { }',
      '}',
      'class B extends A {',
      '  B() { super(2); }',
      '}',
    );
    const head = lines(
      'class A {',
      '  A() { this(2); }',
      '  A(int x) { int y = x; }',
      '}',
      'class B extends A {',
      '  B() { super(3); }',
      '}',
    );
    const result = await analyse({ 'A.java': base }, { 'A.java': head });
    // The two A constructors are one overload set (#42), so `this(…)` inside it is a self-call.
    expect(newSide(summary(result))).toEqual([
      'new calls B.B -> A.A @A.java:6 text-search:candidate',
    ]);
    expect(result.evidence.records[0]!.detail).toBe('super(…) constructor chaining');
  });

  it('finds Python __init__ through calls of the class and super().__init__', async () => {
    const result = await analyse(
      {
        'shapes.py': lines(
          'class Shape:',
          '    def __init__(self, n):',
          '        self.n = n',
          '',
          '',
          'class Square(Shape):',
          '    def __init__(self):',
          '        super().__init__(1)',
          '',
          '',
          'def make() -> Shape:',
          '    return Shape(1)',
          '',
          '',
          'def check(x):',
          '    return isinstance(x, Shape)',
        ),
      },
      {
        'shapes.py': lines(
          'class Shape:',
          '    def __init__(self, n, m=0):',
          '        self.n = n',
          '',
          '',
          'class Square(Shape):',
          '    def __init__(self):',
          '        super().__init__(2)',
          '',
          '',
          'def make() -> Shape:',
          '    return Shape(2)',
          '',
          '',
          'def check(x):',
          '    return isinstance(x, Shape) or None',
        ),
      },
    );
    expect(newSide(summary(result))).toEqual([
      'new calls Square.__init__ -> Shape.__init__ @shapes.py:8 text-search:candidate',
      'new calls make -> Shape.__init__ @shapes.py:12 text-search:candidate',
    ]);
  });
});

describe('analyzeSemantics: test files and caps', () => {
  it('keeps one edge per (test file, changed entity) (D2)', async () => {
    const test = (n: number) =>
      lines(
        "import { formatPrice } from '../src/price';",
        "import { other } from '../src/other';",
        "it('formats', () => {",
        `  expect(formatPrice(${n})).toBe('1');`,
        `  expect(formatPrice(${n + 1})).toBe('2');`,
        '});',
        "it('formats again', () => {",
        `  expect(formatPrice(${n + 2})).toBe('3');`,
        '});',
      );
    const result = await analyse(
      {
        'src/price.ts': PRICE_BASE,
        'src/other.ts': lines('export function formatPrice() {', '  return 1;', '}'),
        'test/price.test.ts': test(1),
      },
      { 'src/price.ts': PRICE_HEAD, 'test/price.test.ts': test(4) },
    );
    expect(newSide(summary(result))).toEqual([
      'new calls formats -> formatPrice @test/price.test.ts:4 text-search:candidate import-resolution:confirmed',
    ]);
    const first = result.evidence.records.find((r) => r.location.side === 'new')!;
    expect(first.detail).toBe('call; test file: one hit for 3 new-side hits');
    // One hit per side, so the edge still shows the call was there before the change too.
    expect(oldSide(summary(result))).toEqual([
      'old calls formats -> formatPrice @test/price.test.ts:4 text-search:candidate import-resolution:confirmed',
    ]);
  });

  it('neither resolves to nor searches for a test block named like the code under test', async () => {
    // describe('formatPrice') is an entity named formatPrice. Its title is no definition, so
    // src/price.ts has the only one (the unambiguous rule), and the block is no target.
    const test = (n: number) =>
      lines(
        "import { formatPrice } from '../src/price';",
        "describe('formatPrice', () => {",
        "  it('formats', () => {",
        `    expect(formatPrice(${n})).toBe('1');`,
        '  });',
        '});',
      );
    const result = await analyse(
      { 'src/price.ts': PRICE_BASE, 'test/price.test.ts': test(1) },
      { 'src/price.ts': PRICE_HEAD, 'test/price.test.ts': test(2) },
    );
    expect(newSide(summary(result))).toEqual([
      'new calls formatPrice.formats -> formatPrice @test/price.test.ts:4 text-search:candidate',
    ]);
    expect(result.evidence.records.map((r) => r.targetEntityId)).toEqual(
      result.evidence.records.map(() => result.structure.entities[0]!.id),
    );
  });

  it('caps the candidates per changed entity and says so', async () => {
    const caller = (name: string, arg: string) =>
      lines(
        "import { formatPrice } from './price';",
        `export function ${name}() {`,
        `  return formatPrice(${arg});`,
        '}',
      );
    const base: Files = { 'src/price.ts': PRICE_BASE };
    const head: Files = { 'src/price.ts': PRICE_HEAD };
    for (const name of ['a', 'b', 'c']) {
      base[`src/${name}.ts`] = caller(name, '1');
      head[`src/${name}.ts`] = caller(name, "1, 'EUR'");
    }
    const result = await analyse(base, head, { maxCandidatesPerEntity: 2 });
    const target = result.structure.entities.find((e) => e.name === 'formatPrice')!.id;
    expect(result.evidence.caps).toEqual([
      { entityId: target, relation: 'calls', shown: 2, total: 3 },
    ]);
    expect(newSide(summary(result)).map((l) => l.split(' ')[2])).toEqual(['a', 'b']);
  });
});

describe('analyzeSemantics: language server answers', () => {
  /** A fake provider: `answer` per target; files in `broken` (or all) do not resolve. */
  function fakeLsp(
    answer: (target: ReferenceTarget) => ReferencesResult,
    broken: readonly string[] | 'all' = [],
  ): ReferenceProvider & { asked: ReferenceTarget[] } {
    const asked: ReferenceTarget[] = [];
    return {
      asked,
      references: (target) => {
        asked.push(target);
        return Promise.resolve(answer(target));
      },
      projectHealth: (_language, paths) => {
        const healthy = broken !== 'all' && !paths.some((p) => broken.includes(p));
        return Promise.resolve({
          healthy,
          imports: 1,
          unresolved: [],
          reason: healthy ? null : 'broken',
        });
      },
      capabilities: () => [],
    };
  }
  const site = (path: string, line: number, column: number) => ({
    path,
    range: { startLine: line, startColumn: column, endLine: line, endColumn: column + 11 },
    via: 'direct' as const,
  });
  const ok = (...references: ReferenceSite[]): ReferencesResult => ({
    status: 'ok',
    references,
    unresolved: [],
    complete: true,
  });

  it('confirms returned sites and rejects missing ones only when the project resolves', async () => {
    const lsp = fakeLsp(() => ok(site('src/checkout.ts', 4, 25)));
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, { lsp });
    expect(lsp.asked).toContainEqual({
      language: 'typescript',
      path: 'src/price.ts',
      line: 1,
      column: 17,
      kind: 'function',
    });
    const ts = newSide(summary(result)).filter((l) => l.includes('formatPrice'));
    expect(ts).toContain(
      'new calls checkoutSummary -> formatPrice @src/checkout.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
    );
    expect(ts).toContain(
      'new calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate lsp:rejected',
    );
    // Import resolution already said no; the server is not asked to repeat it.
    expect(ts).toContain(
      'new calls legacyLabel -> formatPrice @src/legacyLabel.ts:4 text-search:candidate import-resolution:rejected',
    );

    const unhealthy = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp: fakeLsp(() => ok(site('src/checkout.ts', 4, 25)), 'all'),
    });
    expect(
      unhealthy.evidence.records.filter((r) => r.outcome === 'rejected' && r.method === 'lsp'),
    ).toEqual([]);
  });

  it('only stops rejections that involve a file whose imports do not resolve', async () => {
    const rejected = async (broken: string[]) => {
      // No references at all: every open candidate in a resolving file is rejected.
      const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
        lsp: fakeLsp(() => ok(), broken),
      });
      return result.evidence.records
        .filter((r) => r.method === 'lsp' && r.outcome === 'rejected' && r.location.side === 'new')
        .map((r) => r.location.path)
        .filter((p) => p.endsWith('.ts'));
    };
    expect(await rejected([])).toEqual([
      'src/checkout.ts',
      'src/fmt.ts',
      'src/invoice.ts',
      'src/receipt.ts',
      'src/viaAlias.ts',
    ]);
    // A broken caller file loses its own rejection only.
    expect(await rejected(['src/invoice.ts'])).toEqual([
      'src/checkout.ts',
      'src/fmt.ts',
      'src/receipt.ts',
      'src/viaAlias.ts',
    ]);
    // A broken target file affects every candidate of that target.
    expect(await rejected(['src/price.ts'])).toEqual([]);
  });

  it('never rejects on an unknown answer, an incomplete one, or for a possible override', async () => {
    const unknown = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp: fakeLsp(() => ({ status: 'unknown', reason: 'not ready' })),
    });
    expect(unknown.evidence.records.filter((r) => r.method === 'lsp')).toEqual([]);

    const incomplete = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp: fakeLsp(() => ({ ...ok(), complete: false })),
    });
    expect(incomplete.evidence.records.filter((r) => r.method === 'lsp')).toEqual([]);

    const overrideLsp = fakeLsp(() => ok());
    const override = await analyse(
      {
        'src/shapes.ts': lines(
          'class Shape {',
          '  area() { return 0; }',
          '}',
          'export class Square extends Shape {',
          '  area() { return 1; }',
          '}',
          'export function total(s: Shape) {',
          '  return s.area();',
          '}',
        ),
      },
      {
        'src/shapes.ts': lines(
          'class Shape {',
          '  area() { return 0; }',
          '}',
          'export class Square extends Shape {',
          '  area() { return 2; }',
          '}',
          'export function total(s: Shape) {',
          '  return s.area() + 0;',
          '}',
        ),
      },
      { lsp: overrideLsp },
    );
    // Its receivers are filtered by type, so a sibling's calls are not confirmed (#21).
    // Calls through Shape are found by asking about Shape.area too (#81).
    expect(overrideLsp.asked).toContainEqual(
      expect.objectContaining({
        kind: 'method',
        receiverTypes: ['Square', 'Shape'],
        baseMethods: [{ path: 'src/shapes.ts', line: 2, column: 3 }],
      }),
    );
    // Square.area may be reached through Shape: its own references miss that call (#42).
    expect(newSide(summary(override))).toEqual([
      'new calls total -> Square.area @src/shapes.ts:8 text-search:candidate',
    ]);
  });

  it('passes the overridden base methods it finds in the snapshot (#81)', async () => {
    const lsp = fakeLsp((t) =>
      t.path === 'src/square.ts' && t.line === 6
        ? ok({ ...site('src/report.ts', 4, 12), via: 'base-method' as const })
        : ok(),
    );
    const shape = lines(
      'export interface Named {',
      '  name(): string;',
      '}',
      'export class Shape {',
      '  area(): number { return 0; }',
      "  name(): string { return 'shape'; }",
      '}',
    );
    const square = (n: number) =>
      lines(
        "import { Shape, type Named } from './shape.ts';",
        "import { Base } from 'some-package';",
        '',
        'export class Square extends Shape implements Named, Base {',
        '  side = 1;',
        `  area(): number { return ${n}; }`,
        `  name(): string { return 'square ${n}'; }`,
        '}',
      );
    const report = (n: number) =>
      lines(
        "import type { Shape } from './shape.ts';",
        '',
        'export function total(s: Shape) {',
        `  return s.area() + s.name() + ${n};`,
        '}',
      );
    const result = await analyse(
      { 'src/shape.ts': shape, 'src/square.ts': square(1), 'src/report.ts': report(1) },
      { 'src/shape.ts': shape, 'src/square.ts': square(2), 'src/report.ts': report(2) },
      { lsp },
    );
    const asked = (line: number) =>
      lsp.asked.find((t) => t.path === 'src/square.ts' && t.line === line);
    // Through an import, in another file. `Base` comes from a package, outside the snapshot.
    expect(asked(6)).toMatchObject({
      receiverTypes: ['Square', 'Shape', 'Named', 'Base'],
      baseMethods: [{ path: 'src/shape.ts', line: 5, column: 3 }],
    });
    // A base class and an interface that both declare it.
    expect(asked(7)?.baseMethods).toEqual([
      { path: 'src/shape.ts', line: 6, column: 3 },
      { path: 'src/shape.ts', line: 2, column: 3 },
    ]);
    expect(newSide(summary(result))).toContain(
      'new calls total -> Square.area @src/report.ts:4 text-search:candidate lsp:confirmed',
    );
  });

  it('passes a Python base method, and none when no base declares one (#81)', async () => {
    const lsp = fakeLsp(() => ok());
    const account = lines('class Account:', '    def interest(self):', '        return 0');
    const savings = (n: number) =>
      lines(
        'from account import Account',
        '',
        '',
        'class Savings(Account):',
        '    def interest(self):',
        `        return ${n}`,
        '',
        '    def bonus(self):',
        `        return ${n}`,
      );
    const report = (n: number) =>
      lines(
        'from account import Account',
        '',
        '',
        'def total(a: Account):',
        `    return a.interest() + a.bonus() + ${n}`,
      );
    await analyse(
      { 'account.py': account, 'savings.py': savings(1), 'report.py': report(1) },
      { 'account.py': account, 'savings.py': savings(2), 'report.py': report(2) },
      { lsp },
    );
    const asked = (line: number) =>
      lsp.asked.find((t) => t.path === 'savings.py' && t.line === line);
    expect(asked(5)).toMatchObject({
      receiverTypes: ['Savings', 'Account'],
      baseMethods: [{ path: 'account.py', line: 2, column: 9 }],
    });
    expect(asked(8)).toMatchObject({ receiverTypes: ['Savings', 'Account'] });
    expect(asked(8)).not.toHaveProperty('baseMethods');
  });

  it('asks a base-side server only about old-side hits no new-side hit stands for (#66)', async () => {
    // The new side confirms checkoutSummary only, so every other new-side hit is rejected.
    const lsp = fakeLsp(() => ok(site('src/checkout.ts', 4, 25)));
    let started: string[] | null = null;
    const oldLsp = {
      ...fakeLsp(() => ok(site('src/invoice.ts', 4, 24))),
      capabilities: () => [
        {
          language: 'typescript',
          server: { name: 'fake', version: null, configuration: null },
          status: 'ok' as const,
          capabilitiesAttempted: ['references' as const],
          failures: [],
          guidance: null,
        },
      ],
    };
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp,
      oldLsp: (languages) => {
        started = languages;
        return Promise.resolve(oldLsp);
      },
    });
    expect(started).toEqual(['typescript', 'python']);
    expect(oldLsp.asked.map((t) => [t.path, t.line])).toEqual([
      ['src/price.ts', 1],
      ['tax.py', 1],
    ]);
    expect(oldSide(summary(result)).filter((l) => l.includes('formatPrice'))).toEqual([
      // Its new-side hit was confirmed: the old side is not asked.
      'old calls checkoutSummary -> formatPrice @src/checkout.ts:4 text-search:candidate import-resolution:confirmed',
      'old calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate lsp:rejected',
      'old calls invoiceSummary -> formatPrice @src/invoice.ts:4 text-search:candidate import-resolution:confirmed lsp:confirmed',
      'old calls legacyLabel -> formatPrice @src/legacyLabel.ts:4 text-search:candidate import-resolution:rejected',
      'old calls receiptSummary -> formatPrice @src/receipt.ts:4 text-search:candidate import-resolution:confirmed lsp:rejected',
      'old calls aliasCaller -> formatPrice @src/viaAlias.ts:4 text-search:candidate import-resolution:confirmed lsp:rejected',
    ]);
    expect(result.evidence.languages).toEqual([
      expect.objectContaining({ language: 'typescript', side: 'old', status: 'ok' }),
    ]);
  });

  it('starts no base-side server when every edge has a new-side hit', async () => {
    let started = false;
    await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp: fakeLsp(() => ({ status: 'unknown', reason: 'not ready' })),
      oldLsp: () => {
        started = true;
        return Promise.resolve(fakeLsp(() => ok()));
      },
    });
    expect(started).toBe(false);
  });

  it('carries a new-side rejection over to the matching old-side hit (#66)', async () => {
    const result = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, { lsp: fakeLsp(() => ok()) });
    const carried = result.evidence.records.find(
      (r) => r.method === 'lsp' && r.location.side === 'old' && r.location.path === 'src/fmt.ts',
    );
    expect(carried).toMatchObject({
      outcome: 'rejected',
      detail:
        'carried over from the new-side hit at src/fmt.ts:8, which the new-side server rejected ' +
        '(not among textDocument/references, and both files resolve)',
    });
    // Import resolution confirmed the other old-side hits; a carried rejection does not overrule it.
    expect(
      result.evidence.records
        .filter((r) => r.method === 'lsp' && r.location.side === 'old')
        .map((r) => r.location.path),
    ).toEqual(['src/fmt.ts', 'calc.py']);

    // A base-side answer wins over a carried rejection.
    const decided = await analyse(SIGNATURE_BASE, SIGNATURE_HEAD, {
      lsp: fakeLsp(() => ok()),
      oldLsp: () => Promise.resolve(fakeLsp(() => ok(site('src/fmt.ts', 8, 12)))),
    });
    expect(oldSide(summary(decided))).toContain(
      'old calls viaMethod -> formatPrice @src/fmt.ts:8 text-search:candidate lsp:confirmed',
    );

    // Unmatched counts: which old-side hit is which is unclear, so nothing is carried over.
    const fmt = (...calls: string[]) =>
      lines(
        'export class Fmt {',
        '  formatPrice(n: number): string {',
        '    return String(n);',
        '  }',
        '}',
        'export function formatPrice(n: number) {',
        '  return n;',
        '}',
        'export function viaMethod(f: Fmt): string {',
        ...calls,
        '}',
      );
    const unmatched = await analyse(
      { 'src/fmt.ts': fmt('  return f.formatPrice(1);') },
      {
        'src/fmt.ts': fmt('  f.formatPrice(2);', '  return f.formatPrice(3);').replace(
          'n;',
          'n + 1;',
        ),
      },
      { lsp: fakeLsp(() => ok()) },
    );
    expect(oldSide(summary(unmatched))).toEqual([
      'old calls viaMethod -> formatPrice @src/fmt.ts:10 text-search:candidate',
    ]);
  });
});
