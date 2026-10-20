import { describe, expect, it } from 'vitest';
import {
  countImports,
  isAliasDeclaration,
  isConstructorCall,
  isImportLine,
  isMethodDeclaration,
  isUnresolvedImport,
  rangeContains,
  receiverOf,
  toSourceRange,
  typeHeaderAt,
  typeNameAt,
} from './normalise.ts';
import type { Range } from './protocol.ts';

const range = (line: number, start: number, end: number, endLine = line): Range => ({
  start: { line, character: start },
  end: { line: endLine, character: end },
});

/** The 0-based range of the first `name` on `line`. */
function at(lines: string[], line: number, name: string, nth = 0): Range {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = lines[line]!.indexOf(name, i + 1);
  return range(line, i, i + name.length);
}

describe('toSourceRange / rangeContains', () => {
  it('converts LSP 0-based ranges to 1-based SourceRange with exclusive end column', () => {
    expect(toSourceRange(range(0, 4, 9))).toEqual({
      startLine: 1,
      startColumn: 5,
      endLine: 1,
      endColumn: 10,
    });
  });

  it('matches candidates inside a range, not only at its start column (#42)', () => {
    // jdtls: `new Gson()` starts at `new`; `org.jsoup.nodes.Node` is one range.
    const gson = toSourceRange(range(9, 12, 22)); // `new Gson()` from column 13
    expect(rangeContains(gson, 10, 17)).toBe(true); // `Gson`
    expect(rangeContains(gson, 10, 23)).toBe(false);
    expect(rangeContains(gson, 9, 17)).toBe(false);
    const multi = toSourceRange(range(1, 10, 3, 3));
    expect(rangeContains(multi, 3, 1)).toBe(true);
    expect(rangeContains(multi, 4, 3)).toBe(true);
    expect(rangeContains(multi, 4, 4)).toBe(false);
  });
});

describe('isImportLine', () => {
  it('recognises single-line imports in TS, Python and Java', () => {
    for (const line of [
      "import { formatPrice } from './price';",
      "import type { X } from './x';",
      'from tax import tax',
      'import tax as t',
      'import org.jsoup.nodes.Node;',
      "const { formatPrice } = require('./price');",
    ]) {
      expect(isImportLine([line], 0), line).toBe(true);
    }
  });

  it('recognises a name inside a multi-line import list', () => {
    const ts = ['import {', '  a,', '  formatPrice,', "} from './price';"];
    expect(isImportLine(ts, 2)).toBe(true);
    const py = ['from tax import (', '    rate,', '    tax,', ')'];
    expect(isImportLine(py, 2)).toBe(true);
  });

  it('keeps calls, dynamic imports and re-exports', () => {
    expect(isImportLine(['  return formatPrice(t);'], 0)).toBe(false);
    expect(isImportLine(["const m = await import('./price');"], 0)).toBe(false);
    expect(isImportLine(["export { formatPrice as fmt } from './price';"], 0)).toBe(false);
    // A call on the line after a finished import statement.
    expect(isImportLine(["import { a } from './a';", 'a(formatPrice);'], 1)).toBe(false);
    // An argument list continuing from a call, not an import.
    expect(isImportLine(['foo(', '  formatPrice,', ')'], 1)).toBe(false);
  });
});

describe('isAliasDeclaration', () => {
  it('drops the alias name of a re-export, which only tsserver returns', () => {
    const lines = ["export { formatPrice as fmt } from './price';"];
    expect(isAliasDeclaration(lines, at(lines, 0, 'fmt'))).toBe(true);
    expect(isAliasDeclaration(lines, at(lines, 0, 'formatPrice'))).toBe(false);
  });
});

describe('isConstructorCall', () => {
  it('keeps call sites of a class and drops other uses (#42)', () => {
    const lines = [
      'const a = new Square(2);',
      'const b = new shapes.Square(2);',
      'b = Square(2)',
      'const c = new Box<number>(1);',
      'x: Square = y',
      'isinstance(x, Square)',
      'function f(s: Square): Square {}',
      'new Gson()',
    ];
    expect(isConstructorCall(lines, at(lines, 0, 'Square'))).toBe(true);
    expect(isConstructorCall(lines, at(lines, 1, 'Square'))).toBe(true);
    expect(isConstructorCall(lines, at(lines, 2, 'Square'))).toBe(true);
    expect(isConstructorCall(lines, at(lines, 3, 'Box'))).toBe(true);
    expect(isConstructorCall(lines, at(lines, 4, 'Square'))).toBe(false);
    expect(isConstructorCall(lines, at(lines, 5, 'Square'))).toBe(false);
    expect(isConstructorCall(lines, at(lines, 6, 'Square'))).toBe(false);
    expect(isConstructorCall(lines, range(7, 0, 10))).toBe(true); // jdtls range from `new`
  });
});

describe('isMethodDeclaration', () => {
  it('recognises method declarations and not calls', () => {
    const decl = [
      '  area(): number {',
      '  override area(): number {',
      '    def area(self) -> float:',
      '  public double area() {',
      '  async area<T>(x: T) {',
      '  area(): void {}',
      '  public void area() throws IOException { log(); }',
      '  area(cb: () => void): Promise<void> { return run(cb); }',
      '  area(): number;',
    ];
    for (let i = 0; i < decl.length; i++) {
      expect(isMethodDeclaration(decl, at(decl, i, 'area')), decl[i]).toBe(true);
    }
    const calls = [
      '    area();',
      '    return s.area();',
      '    if (area()) {',
      '    x = self.area()',
      '    if area(x):',
      '    area(() => { done(); });',
      '    area().then(() => {});',
      '    area() || {};',
      '    area();',
    ];
    for (let i = 0; i < calls.length; i++) {
      expect(isMethodDeclaration(calls, at(calls, i, 'area')), calls[i]).toBe(false);
    }
  });
});

describe('receiverOf', () => {
  const recv = (line: string, name = 'area') => receiverOf(line, line.indexOf(`.${name}`) + 1);

  it('finds the identifier before the dot', () => {
    expect(recv('n + s.area()')).toEqual({ kind: 'identifier', name: 's', character: 4 });
    expect(recv('this.el.area()')).toEqual({ kind: 'identifier', name: 'el', character: 5 });
    expect(recv('x?.area()')).toEqual({ kind: 'identifier', name: 'x', character: 0 });
  });

  it('classifies super, expressions and bare calls', () => {
    expect(recv('return super.area();')).toEqual({ kind: 'super' });
    expect(recv('make().area()')).toEqual({ kind: 'expression' });
    expect(recv('items[0].area()')).toEqual({ kind: 'expression' });
    expect(receiverOf('  area();', 2)).toEqual({ kind: 'none' });
  });
});

describe('typeNameAt', () => {
  it('reads an identifier range or the name declared at a declaration range', () => {
    const lines = ['export class Shape {', '}', '@dataclass', 'class Point:'];
    expect(typeNameAt(lines, at(lines, 0, 'Shape'))).toBe('Shape');
    expect(typeNameAt(lines, range(0, 0, 1, 1))).toBe('Shape');
    expect(typeNameAt(lines, range(2, 0, 3, 12))).toBe('Point');
    expect(typeNameAt(['let x = 1;'], range(0, 0, 10))).toBeNull();
  });
});

describe('typeHeaderAt', () => {
  const bases = (lines: string[], name: string, line = 0) => {
    const header = typeHeaderAt(lines, at(lines, line, name));
    return (
      header && [
        header.keyword,
        header.bases?.map((b) => `${b.name}@${b.at.line}:${b.at.character}`) ?? null,
      ]
    );
  };

  it('reads TypeScript and Java heritage clauses', () => {
    expect(
      bases(
        ['export abstract class A<T extends B<T>> extends m.Base<T> implements I, J<() => void> {'],
        'A',
      ),
    ).toEqual(['class', ['Base@0:50', 'I@0:69', 'J@0:72']]);
    expect(bases(['export class A', '  extends B', '  implements C {'], 'A')).toEqual([
      'class',
      ['B@1:10', 'C@2:13'],
    ]);
    expect(bases(['interface I extends J, K {}'], 'I')).toEqual([
      'interface',
      ['J@0:20', 'K@0:23'],
    ]);
    expect(bases(['public final class A {'], 'A')).toEqual(['class', []]);
    expect(bases(['record R(int x) implements I {'], 'R')).toEqual(['record', ['I@0:27']]);
    expect(bases(['sealed class S extends T permits U, V {'], 'S')).toEqual(['class', ['T@0:23']]);
    expect(bases(['type T = { a: 1 };'], 'T')).toEqual(['type', null]);
    // A base that is not a name cannot be followed.
    expect(bases(['class A extends mixin(B) {'], 'A')).toEqual(['class', null]);
  });

  it('reads Python base lists', () => {
    expect(bases(['class A(base.B, Generic[T], metaclass=M):'], 'A')).toEqual([
      'class',
      ['B@0:13', 'Generic@0:16'],
    ]);
    expect(bases(['class A:'], 'A')).toEqual(['class', []]);
    expect(bases(['class A(*bases):'], 'A')).toEqual(['class', null]);
    expect(typeHeaderAt(['x = 1'], range(0, 0, 1))).toBeNull();
  });
});

describe('health helpers', () => {
  it('counts import statements, not imported names', () => {
    const text = [
      "import { a, b } from './a';",
      'import {',
      '  c,',
      "} from './c';",
      "const d = require('d');",
      'from x import (y, z)',
      'import os',
      'importantThing();',
    ].join('\n');
    expect(countImports(text)).toBe(5);
  });

  it('recognises unresolved-import diagnostics from pyright, tsserver and jdtls', () => {
    const d = (code: string | number | undefined, message: string) => ({
      range: range(0, 0, 1),
      message,
      ...(code === undefined ? {} : { code }),
    });
    expect(isUnresolvedImport(d('reportMissingImports', 'Import "x" could not be resolved'))).toBe(
      true,
    );
    expect(isUnresolvedImport(d(2307, "Cannot find module './x'"))).toBe(true);
    expect(isUnresolvedImport(d(268435846, 'The import a.b cannot be resolved'))).toBe(true);
    expect(isUnresolvedImport(d(undefined, 'Import "x" could not be resolved'))).toBe(true);
    // Stubs-only: the import resolves for type checking.
    expect(
      isUnresolvedImport(
        d('reportMissingModuleSource', 'Import "yaml" could not be resolved from source'),
      ),
    ).toBe(false);
    expect(isUnresolvedImport(d(2345, 'Argument of type ...'))).toBe(false);
  });
});
