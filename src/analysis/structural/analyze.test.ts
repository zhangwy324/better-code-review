import { describe, expect, it } from 'vitest';
import { extractChangeSet } from '../../git/extract.ts';
import { TestRepo } from '../../git/test-repo.test-helper.ts';
import type { ChangeSet } from '../../schemas/changeset.ts';
import type { StructuralChangeSet } from '../../schemas/structural.ts';
import { analyzeStructure, type StructuralOptions } from './analyze.ts';

// Fixtures are real two-commit repositories run through the Git extractor, so hunks are exactly
// what Git produces. Files are written straight into the index; nothing is checked out.
type Files = Record<string, string | Buffer | null>;

async function changeSetOf(base: Files, head: Files): Promise<ChangeSet> {
  const repo = new TestRepo();
  const commit = repo.commit([repo.commit([], base)], head);
  return extractChangeSet(repo.path, { kind: 'commit', commit });
}

async function analyse(base: Files, head: Files, options?: StructuralOptions) {
  const changes = await changeSetOf(base, head);
  const structure = await analyzeStructure(changes, options);
  expectEveryHunkAccountedFor(changes, structure);
  return { changes, structure };
}

/** Acceptance: every hunk is attributed to an entity or listed as unattributed. */
function expectEveryHunkAccountedFor(changes: ChangeSet, structure: StructuralChangeSet) {
  const accounted = new Set([
    ...structure.entities.flatMap((e) => e.hunkIds),
    ...structure.unattributedHunkIds,
  ]);
  for (const hunk of changes.files.flatMap((f) => f.hunks)) expect(accounted).toContain(hunk.id);
}

/** `change kind container.name` per entity, `<module>` for module entities. */
function summary(structure: StructuralChangeSet): string[] {
  return structure.entities.map((e) => {
    const name = e.name === null ? '<module>' : `${e.container ? `${e.container}.` : ''}${e.name}`;
    return `${e.change} ${e.kind} ${name}`;
  });
}

const lines = (...l: string[]) => `${l.join('\n')}\n`;
/** Keeps the changes around it in separate hunks. */
const FILLER = ['', ...Array.from({ length: 6 }, (_, i) => `// filler ${i + 1}`), ''];

describe('analyzeStructure', () => {
  it('attributes hunks to the innermost entity, and code outside entities to the module', async () => {
    const base = {
      'src/price.ts': lines(
        "import { round } from './round';",
        ...FILLER,
        'export class Fmt {',
        '  constructor(private readonly locale: string) {}',
        '',
        '  /** Formats an amount. */',
        '  format(amount: number): string {',
        '    return round(amount).toString();',
        '  }',
        '}',
        '',
        'export function formatPrice(amount: number): string {',
        '  return new Fmt("en").format(amount);',
        '}',
        ...FILLER,
        'export const VAT = 0.2;',
      ),
    };
    const head = {
      'src/price.ts': lines(
        "import { round } from './round.js';",
        ...FILLER,
        'export class Fmt {',
        '  constructor(private readonly locale: string) {}',
        '',
        '  /** Formats an amount in the locale. */',
        '  format(amount: number): string {',
        '    return round(amount).toString();',
        '  }',
        '}',
        '',
        'export function formatPrice(amount: number, currency: string): string {',
        '  return `${new Fmt("en").format(amount)} ${currency}`;',
        '}',
        ...FILLER,
        'export const VAT = 0.25;',
      ),
    };
    const { changes, structure } = await analyse(base, head);
    expect(summary(structure)).toEqual([
      'modified module <module>',
      'modified method Fmt.format',
      'modified function formatPrice',
    ]);
    expect(structure.files).toEqual([
      {
        path: 'src/price.ts',
        language: 'typescript',
        tier: 'supported',
        test: null,
        skipped: null,
      },
    ]);
    expect(structure.unattributedHunkIds).toEqual([]);

    const hunk = (text: string) => changes.files[0]!.hunks.find((h) => h.patch.includes(text))!.id;
    const [module, method, fn] = structure.entities;
    // The doc comment belongs to the method, not the class (#42).
    expect(method).toMatchObject({
      hunkIds: [hunk('in the locale')],
      oldRange: { startLine: 13, startColumn: 3, endLine: 16, endColumn: 4 },
      newRange: { startLine: 13, startColumn: 3, endLine: 16, endColumn: 4 },
    });
    expect(module).toMatchObject({
      hunkIds: [hunk('round.js'), hunk('VAT')],
      oldRange: null,
    });
    expect(fn).toMatchObject({
      hunkIds: [hunk('currency: string')],
      container: null,
      path: 'src/price.ts',
      oldPath: null,
      newRange: { startLine: 19, endLine: 21 },
    });
  });

  it('attaches a hunk to every entity its lines are in', async () => {
    const { changes, structure } = await analyse(
      { 'a.py': lines('def a():', '    return 1', '', 'def b():', '    return 2') },
      { 'a.py': lines('def a():', '    return 10', '', 'def b():', '    return 20') },
    );
    const [hunk] = changes.files[0]!.hunks;
    expect(changes.files[0]!.hunks).toHaveLength(1);
    expect(summary(structure)).toEqual(['modified function a', 'modified function b']);
    for (const e of structure.entities) expect(e.hunkIds).toEqual([hunk!.id]);
  });

  it('classifies added, deleted, renamed and moved entities', async () => {
    const body = (n: string) => [
      `  const total = ${n}.reduce((s, x) => s + x.price, 0);`,
      '  return total;',
    ];
    const { structure } = await analyse(
      {
        'src/cart.ts': lines(
          'export function sum(items: Item[]): number {',
          ...body('items'),
          '}',
          '',
          'export function legacy(): void {}',
          '',
          'export function tax(amount: number, rate: number): number {',
          '  const base = amount * rate;',
          '  const rounded = Math.round(base * 100) / 100;',
          '  return rounded;',
          '}',
          '',
          'export function shipping(weight: number): number {',
          '  const perKilo = 2;',
          '  const handling = 5;',
          '  return weight * perKilo + handling;',
          '}',
          '',
          'export function discount(amount: number): number {',
          '  return amount * 0.9;',
          '}',
        ),
      },
      {
        'src/cart.ts': lines(
          'export function total(items: Item[]): number {',
          ...body('items'),
          '}',
          '',
          'export function vat(amount: number, rate: number): number {',
          '  const base = amount * rate;',
          '  const rounded = Math.round(base * 1000) / 1000;',
          '  return rounded;',
          '}',
          '',
          'export function postage(weightKg: number): number {',
          '  const perKilo = 2;',
          '  const handling = 5;',
          '  return weightKg * perKilo + handling;',
          '}',
          '',
          'export function fresh(): void {}',
        ),
        'src/discount.ts': lines(
          'export function discount(amount: number): number {',
          '  return amount * 0.9;',
          '}',
        ),
      },
    );
    const byName = new Map(structure.entities.map((e) => [e.name, e]));
    // Same body: content hash.
    expect(byName.get('total')).toMatchObject({
      change: 'renamed',
      path: 'src/cart.ts',
      oldPath: null,
    });
    // Same signature, edited body.
    expect(byName.get('vat')).toMatchObject({ change: 'renamed' });
    // Different signature and edited body: fuzzy similarity.
    expect(byName.get('postage')).toMatchObject({ change: 'renamed' });
    // To another file: content hash.
    expect(byName.get('discount')).toMatchObject({
      change: 'moved',
      path: 'src/discount.ts',
      oldPath: 'src/cart.ts',
    });
    expect(byName.get('discount')!.hunkIds).toHaveLength(2);
    expect(byName.get('legacy')).toMatchObject({ change: 'deleted', newRange: null });
    expect(byName.get('fresh')).toMatchObject({ change: 'added', oldRange: null });
    expect(byName.get('sum')).toBeUndefined();
  });

  it('matches members of a renamed class by name', async () => {
    const shop = (name: string, size: number) =>
      lines(
        `class ${name} {`,
        '  int size() {',
        `    return ${size};`,
        '  }',
        '',
        '  String label() {',
        '    return "items: " + size();',
        '  }',
        '}',
      );
    const { structure } = await analyse(
      {
        'Shop.java': shop('Basket', 0),
      },
      {
        'Shop.java': shop('Cart', 1),
      },
    );
    expect(summary(structure)).toEqual(['renamed class Cart', 'modified method Cart.size']);
  });

  it('treats overloads as one entity', async () => {
    const { structure } = await analyse(
      {
        'f.ts': lines(
          'export function format(amount: number): string;',
          'export function format(amount: number, currency?: string): string {',
          '  return String(amount);',
          '}',
        ),
      },
      {
        'f.ts': lines(
          'export function format(amount: bigint): string;',
          'export function format(amount: number | bigint, currency?: string): string {',
          '  return String(amount);',
          '}',
        ),
      },
    );
    expect(summary(structure)).toEqual(['modified function format']);
    expect(structure.entities[0]!.newRange).toMatchObject({ startLine: 1, endLine: 4 });
  });

  it('JavaScript: default exports, assignments, class fields and test blocks', async () => {
    const { structure } = await analyse(
      {
        'lib.js': lines(
          'export default function () {',
          '  return 1;',
          '}',
          'module.exports.helper = () => 1;',
          'class Btn {',
          '  onClick = () => 1;',
          '}',
        ),
        'lib.test.js': lines(
          "describe('lib', () => {",
          "  it('works', () => {",
          '    expect(1).toBe(1);',
          '  });',
          '});',
        ),
      },
      {
        'lib.js': lines(
          'export default function () {',
          '  return 2;',
          '}',
          'module.exports.helper = () => 2;',
          'class Btn {',
          '  onClick = () => 2;',
          '}',
        ),
        'lib.test.js': lines(
          "describe('lib', () => {",
          "  it('works', () => {",
          '    expect(2).toBe(2);',
          '  });',
          '});',
        ),
      },
    );
    expect(summary(structure)).toEqual([
      'modified function default',
      'modified function helper',
      'modified method Btn.onClick',
      'modified function lib.works',
    ]);
    expect(structure.files.map((f) => f.test)).toEqual([null, 'path-convention']);
  });

  it('Python: decorators, nested functions, lambdas and inner classes', async () => {
    const { structure } = await analyse(
      {
        'calc.py': lines(
          'class Calc:',
          '    class Rounding:',
          '        mode = "up"',
          '',
          '    @staticmethod',
          '    def tax(amount):',
          '        def rate():',
          '            return 0.1',
          '        return amount * rate()',
          '',
          'double = lambda x: x * 2',
        ),
      },
      {
        'calc.py': lines(
          'class Calc:',
          '    class Rounding:',
          '        mode = "down"',
          '',
          '    @classmethod',
          '    def tax(amount):',
          '        def rate():',
          '            return 0.2',
          '        return amount * rate()',
          '',
          'double = lambda x: x * 3',
        ),
      },
    );
    expect(summary(structure)).toEqual([
      'modified class Calc.Rounding',
      'modified method Calc.tax',
      'modified function Calc.tax.rate',
      'modified function double',
    ]);
    // The decorator is part of the method.
    expect(structure.entities[1]!.newRange).toMatchObject({ startLine: 5, endLine: 9 });
  });

  it('Java: constructors, records, enums, inner classes and Javadoc', async () => {
    const java = (n: number) =>
      lines(
        'public class Price {',
        `  private final int scale = ${n};`,
        '',
        `  /** Creates a price, v${n}. */`,
        '  public Price() {}',
        '',
        `  record Money(int amount) { Money { assert amount > ${n}; } }`,
        '',
        `  enum Currency { EUR, USD${n === 2 ? ', GBP' : ''} }`,
        '',
        '  static class Parser {',
        `    int parse(String s) { return ${n}; }`,
        '  }',
        '}',
      );
    const { structure } = await analyse({ 'Price.java': java(1) }, { 'Price.java': java(2) });
    expect(summary(structure)).toEqual([
      'modified class Price',
      'modified constructor Price.Price',
      'modified constructor Price.Money.Money',
      'modified enum Price.Currency',
      'modified method Price.Parser.parse',
    ]);
  });

  it('falls back to unattributed hunks for files without structure', async () => {
    const big = `export const x = 1;\n${'// filler\n'.repeat(200)}`;
    const { changes, structure } = await analyse(
      {
        'README.md': 'one\n',
        'logo.png': Buffer.from([0x89, 0x50, 0, 1]),
        'big.ts': big,
        'gen.ts': '// @generated by protoc\nexport const a = 1;\n',
        'broken.ts': 'export function ok() {\n  return 1;\n}\n',
      },
      {
        'README.md': 'two\n',
        'logo.png': Buffer.from([0x89, 0x50, 0, 2]),
        'big.ts': big.replace('x = 1', 'x = 2'),
        'gen.ts': '// @generated by protoc\nexport const a = 2;\n',
        'broken.ts': 'export function ok() {\n  return (1;\n}\n',
      },
      { maxParseBytes: 1000 },
    );
    expect(structure.files.map((f) => [f.path, f.language, f.tier, f.skipped])).toEqual([
      ['README.md', null, 'text-only', null],
      ['big.ts', 'typescript', 'supported', 'too-large'],
      ['broken.ts', 'typescript', 'supported', 'parse-error'],
      ['gen.ts', 'typescript', 'supported', 'generated'],
      ['logo.png', null, 'text-only', 'binary'],
    ]);
    expect(structure.entities).toEqual([]);
    expect(structure.unattributedHunkIds).toEqual(
      changes.files.flatMap((f) => f.hunks.map((h) => h.id)),
    );
  });

  it('gives added and deleted files added and deleted entities', async () => {
    const { structure } = await analyse(
      { 'old.py': lines('import os', 'def gone():', '    pass') },
      { 'old.py': null, 'new.py': lines('import sys', 'def fresh():', '    pass') },
    );
    expect(summary(structure)).toEqual([
      'added module <module>',
      'added function fresh',
      'deleted module <module>',
      'deleted function gone',
    ]);
    expect(structure.entities.map((e) => e.path)).toEqual(['new.py', 'new.py', 'old.py', 'old.py']);
  });

  it('classifies test files by declared test roots and by content', async () => {
    const { structure } = await analyse(
      {},
      {
        'qa/checks.py': 'def check():\n    pass\n',
        'src/testing/helpers.ts': "import { vi } from 'vitest';\nexport const h = vi.fn();\n",
        'src/testing/clock.ts': 'export const now = () => 0;\n',
        'src/contest.ts': "import { vi } from 'vitest';\n",
      },
      { testRoots: { directories: ['qa'], globs: [], patterns: [] } },
    );
    expect(structure.files.map((f) => [f.path, f.test])).toEqual([
      ['qa/checks.py', 'declared-test-root'],
      ['src/contest.ts', null],
      ['src/testing/clock.ts', null],
      ['src/testing/helpers.ts', 'content'],
    ]);
  });

  it('is deterministic', async () => {
    const changes = await changeSetOf(
      { 'a.ts': 'export function f() {}\n' },
      { 'a.ts': 'export function f() { return 1; }\nexport function g() {}\n' },
    );
    expect(await analyzeStructure(changes)).toEqual(await analyzeStructure(changes));
  });
});
