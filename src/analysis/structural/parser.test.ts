import { afterAll, describe, expect, it } from 'vitest';
import type { FileChange } from '../../schemas/changeset.ts';
import {
  StructuralParser,
  declarations,
  freeTrees,
  type ParsedFile,
  type ParseResult,
} from './parser.ts';

const parser = new StructuralParser();
const results: ParseResult[] = [];
afterAll(() => {
  freeTrees(...results);
  parser.delete();
});

async function parsed(path: string, source: string): Promise<ParsedFile> {
  const result = await parser.parse(path, source);
  results.push(result);
  if (result.status !== 'parsed') throw new Error(`${path} was not parsed`);
  return result;
}

/** `kind name` per declaration, with ` [test]` for tests. */
async function summary(path: string, source: string): Promise<string[]> {
  const file = await parsed(path, source);
  expect(file.hasErrors).toBe(false);
  return declarations(file).map((d) => `${d.kind} ${d.name}${d.test ? ' [test]' : ''}`);
}

describe('StructuralParser', () => {
  it('reports unsupported files instead of throwing', async () => {
    for (const path of ['main.go', 'README.md', 'logo.png', 'Makefile']) {
      expect(await parser.parse(path, 'anything at all\0')).toEqual({
        status: 'unsupported',
        path,
        language: null,
      });
    }
  });

  it('parses each built-in language', async () => {
    const sources: [string, string, string][] = [
      ['a.ts', 'const x: number = 1;', 'program'],
      ['a.tsx', 'const el = <div>{x}</div>;', 'program'],
      ['a.js', 'const el = <div />;', 'program'],
      ['a.py', 'x = 1\n', 'module'],
      ['A.java', 'class A {}', 'program'],
    ];
    for (const [path, source, root] of sources) {
      const file = await parsed(path, source);
      expect(file.tree.rootNode.type).toBe(root);
      expect(file.hasErrors).toBe(false);
    }
  });

  it('parses files with syntax errors and flags them', async () => {
    const file = await parsed('broken.ts', 'function f( {');
    expect(file.hasErrors).toBe(true);
  });

  it('parses both sides of a change, each with its own language', async () => {
    const change: FileChange = {
      status: 'renamed',
      oldPath: 'src/price.js',
      newPath: 'src/price.ts',
      oldMode: '100644',
      newMode: '100644',
      binary: false,
      oldContent: 'export function formatPrice(amount) {}\n',
      newContent: 'export function formatPrice(amount: number, currency: string) {}\n',
      contentOmitted: null,
      hunks: [],
    };
    const versions = await parser.parseVersions(change);
    try {
      expect(versions.old).toMatchObject({ status: 'parsed', language: 'javascript' });
      expect(versions.new).toMatchObject({ status: 'parsed', language: 'typescript' });
    } finally {
      freeTrees(versions);
    }
  });

  it('returns null for a side without content', async () => {
    const added: FileChange = {
      status: 'added',
      oldPath: null,
      newPath: 'tax.py',
      oldMode: null,
      newMode: '100644',
      binary: false,
      oldContent: null,
      newContent: 'def tax(amount):\n    return amount\n',
      contentOmitted: null,
      hunks: [],
    };
    const versions = await parser.parseVersions(added);
    try {
      expect(versions.old).toBeNull();
      expect(versions.new).toMatchObject({ status: 'parsed', language: 'python' });
    } finally {
      freeTrees(versions);
    }
  });

  it('frees trees', async () => {
    const result = await parser.parse('a.ts', 'let a = 1;');
    if (result.status !== 'parsed') throw new Error('not parsed');
    let deleted = 0;
    const original = result.tree.delete.bind(result.tree);
    result.tree.delete = () => {
      deleted++;
      original();
    };
    freeTrees(result, null, { status: 'unsupported', path: 'x.go', language: null });
    expect(deleted).toBe(1);
  });
});

describe('declarations', () => {
  it('TypeScript', async () => {
    const source = `import { formatPrice } from './pricing';
import type { Money } from "../money";

export function format(amount: number): string;
export function format(amount: number, currency?: string): string {
  return String(amount);
}

export const toCents = (amount: number) => amount * 100;
const legacy = function (x: number) { return x; };
let notAFunction = 3;

export class Fmt extends Base {
  constructor(private readonly locale: string) { super(); }
  format(amount: number): string { return ''; }
  static parse(text: string): number { return 0; }
}

export abstract class Shape {
  abstract area(): number;
}

interface Priced { price(): number }
type Currency = 'EUR' | 'USD';
enum Rounding { Up, Down }
`;
    expect(await summary('src/pricing.ts', source)).toEqual([
      'import ./pricing',
      'import ../money',
      'function format',
      'function format',
      'function toCents',
      'function legacy',
      'class Fmt',
      'constructor constructor',
      'method format',
      'method parse',
      'class Shape',
      'method area',
      'interface Priced',
      'type Currency',
      'enum Rounding',
    ]);
  });

  it('TSX', async () => {
    const source = `import React from 'react';
export function Price({ amount }: { amount: number }) {
  return <span>{amount}</span>;
}
export const Badge = () => <b />;
`;
    expect(await summary('ui/Price.tsx', source)).toEqual([
      'import react',
      'function Price',
      'function Badge',
    ]);
  });

  it('JavaScript, including test blocks', async () => {
    const source = `import { formatPrice } from './pricing.js';
function* ids() {}
class Cart {
  constructor() {}
  total() {}
}
describe('Cart', () => {
  it('totals', () => {});
  test.skip('later', () => {});
});
`;
    expect(await summary('cart.test.js', source)).toEqual([
      'import ./pricing.js',
      'function ids',
      'class Cart',
      'constructor constructor',
      'method total',
      'function Cart [test]',
      'function totals [test]',
      'function later [test]',
    ]);
  });

  it('Python', async () => {
    const source = `import os.path, json as j
from .calc import tax

def tax(amount, rate=0.1):
    def nested():
        pass
    return amount * rate

class Calc:
    def __init__(self):
        pass

    @staticmethod
    def tax(amount):
        return amount

class TestCalc:
    def test_tax(self):
        assert tax(1) == 0.1

def test_order_total():
    pass
`;
    expect(await summary('py/calc.py', source)).toEqual([
      'import os.path',
      'import json',
      'import .calc',
      'function tax',
      'function nested',
      'class Calc',
      'constructor __init__',
      'method tax',
      'class TestCalc [test]',
      'method test_tax [test]',
      'function test_order_total [test]',
    ]);
  });

  it('Java', async () => {
    const source = `package shop;

import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

public class PriceTest {
  public PriceTest() {}

  @Test
  void formats() {}

  @ParameterizedTest
  @ValueSource(ints = {1, 2})
  void formatsMany(int n) {}

  private String helper() { return ""; }

  interface Formatter { String format(int amount); }
  enum Currency { EUR, USD }
  record Money(int amount) {
    Money {}
  }
  @interface Marker {}
}
`;
    expect(await summary('src/test/java/shop/PriceTest.java', source)).toEqual([
      'import java.util.List',
      'import org.junit.jupiter.api.Assertions',
      'class PriceTest',
      'constructor PriceTest',
      'method formats [test]',
      'method formatsMany [test]',
      'method helper',
      'interface Formatter',
      'method format',
      'enum Currency',
      'class Money',
      'constructor Money',
      'interface Marker',
    ]);
  });

  it('default exports, assignments, object literals and class fields', async () => {
    const source = `export default function () {}
obj.f = () => 1;
module.exports.g = function () {};
const o = { h: () => 1, i() {} };
class C { j = () => 1; static k = function () {}; n = 1; }
`;
    const expected = [
      'function default',
      'function f',
      'function g',
      'function h',
      'method i',
      'class C',
      'method j',
      'method k',
    ];
    expect(await summary('a.js', source)).toEqual(expected);
    expect(await summary('a.ts', source)).toEqual(expected);
    expect(await summary('b.ts', 'export default class {}\nexport default () => 1;\n')).toEqual([
      'class default',
      'function default',
    ]);
  });

  it('Python lambdas', async () => {
    expect(await summary('a.py', 'double = lambda x: x * 2\nn = 1\n')).toEqual(['function double']);
  });

  it('reports 1-based ranges with UTF-16 columns', async () => {
    const file = await parsed('a.ts', 'const é😀 = 1;\nfunction f() {\n}\n');
    const [f] = declarations(file);
    expect(f).toMatchObject({
      kind: 'function',
      name: 'f',
      range: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 2 },
      nameRange: { startLine: 2, startColumn: 10, endLine: 2, endColumn: 11 },
    });
    const file2 = await parsed('b.ts', 'const é😀 = () => 1;');
    expect(declarations(file2)[0]?.nameRange).toEqual({
      startLine: 1,
      startColumn: 7,
      endLine: 1,
      endColumn: 10,
    });
  });
});
