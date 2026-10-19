import { describe, expect, it } from 'vitest';
import { StructuralParser, freeTrees } from '../structural/parser.ts';
import { findHits, type FileHits } from './hits.ts';

const parser = new StructuralParser();

async function hits(path: string, source: string, words: string[]): Promise<FileHits> {
  const parsed = await parser.parse(path, source);
  if (parsed.status !== 'parsed') throw new Error('unsupported');
  try {
    return findHits(parsed, source, words);
  } finally {
    freeTrees(parsed);
  }
}

/** `line:column shape` per hit. */
function shapes(result: FileHits): string[] {
  return result.hits.map((h) => {
    const parts = [h.call ? 'call' : 'ref'];
    if (h.receiver !== null) parts.push(`on ${h.receiver}${h.simpleReceiver ? '' : ' (expr)'}`);
    if (h.heritage) parts.push('heritage');
    if (h.chaining) parts.push(h.chaining);
    return `${h.line}:${h.column} ${parts.join(' ')}`;
  });
}

describe('findHits', () => {
  it('classifies TypeScript occurrences and skips what is not a use', async () => {
    const source = [
      "import { f, g as h } from './f';", // import
      "export { f as alias } from './f';", // re-export
      '// f in a comment',
      "const s = 'f' + `f ${f(1)}`;", // string, string, call inside a template
      'function f(x: number) {}', // declaration
      'const o = { f: 1, f2: f };', // key; reference
      'class C extends f.Base implements F {', // `f` as a namespace, in a base-class list
      '  m(f: number) { return this.f(f) + new f(); }', // parameter; member call; ref; new
      '}',
      'f.call(o); a?.f(); a[0].f;',
      'const fn = (f) => f;', // arrow parameter; reference
      'export default f;', // module level
    ].join('\n');
    const result = await hits('a.ts', source, ['f']);
    expect(shapes(result)).toEqual([
      '4:22 call',
      '6:23 ref',
      '7:17 ref heritage',
      '8:30 call on this (expr)',
      '8:32 ref',
      '8:41 call',
      '10:1 ref',
      '10:15 call on a',
      '10:25 ref on a[0] (expr)',
      '11:19 ref',
    ]);
    // Not code: the comment, two strings and the two './f' specifiers.
    expect(result.skipped).toEqual({ 'not-code': 5, declaration: 3, key: 1, import: 3 });
  });

  it('marks base-class lists and constructor chaining', async () => {
    const source = [
      'class A extends Base implements I {',
      '  constructor() { super(1); super.m(); }',
      '}',
    ].join('\n');
    expect(shapes(await hits('a.ts', source, ['Base', 'I', 'super']))).toEqual([
      '1:17 ref heritage',
      '1:33 ref heritage',
      '2:19 call super',
    ]);
    const result = await hits('a.ts', source, ['super']);
    expect(result.hits[0]!.enclosingClass).toEqual({ name: 'A', bases: ['Base', 'I'] });
  });

  it('classifies Python: module attributes, keyword arguments, super().__init__', async () => {
    const source = [
      'import tax as t',
      'from tax import tax',
      '',
      'class C(Base):',
      '    def __init__(self, tax=1):',
      '        super().__init__(tax=tax)',
      '        t.tax(1)',
      '        tax(2)',
      '        "tax"',
    ].join('\n');
    expect(shapes(await hits('a.py', source, ['tax', '__init__', 'Base']))).toEqual([
      '4:9 ref heritage',
      '6:17 call on super() (expr) super',
      '6:30 ref',
      '7:11 call on t',
      '8:9 call',
    ]);
  });

  it('classifies Java: invocations, creations, this(…) and super(…)', async () => {
    const source = [
      'import a.b.Price;',
      'class A extends Price {',
      '  A() { this(1); }',
      '  A(int x) { super(x); Price p = new Price(); p.cents(); cents(); }',
      '  int cents() { return 0; }',
      '}',
    ].join('\n');
    expect(shapes(await hits('A.java', source, ['Price', 'cents', 'this', 'super']))).toEqual([
      '2:17 ref heritage',
      '3:9 call this',
      '4:14 call super',
      '4:24 ref',
      '4:38 call',
      '4:49 call on p',
      '4:58 call',
    ]);
  });
});
