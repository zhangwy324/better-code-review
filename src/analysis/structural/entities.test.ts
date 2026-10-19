import { afterAll, describe, expect, it } from 'vitest';
import { extractFacts, type Entity } from './entities.ts';
import { StructuralParser, freeTrees, type ParseResult } from './parser.ts';

const parser = new StructuralParser();
const results: ParseResult[] = [];
afterAll(() => {
  freeTrees(...results);
  parser.delete();
});

async function facts(path: string, source: string) {
  const result = await parser.parse(path, source);
  results.push(result);
  if (result.status !== 'parsed') throw new Error(`${path} was not parsed`);
  return extractFacts(result);
}

/** `container.name lines` per entity, e.g. `Fmt.format 3-5`. */
const spans = (entities: Entity[]) =>
  entities.map(
    (e) =>
      `${e.container ? `${e.container}.` : ''}${e.name} ${e.members
        .map((r) => `${r.startLine}-${r.endLine}`)
        .join(',')}`,
  );

describe('extractFacts', () => {
  it('extends spans over adjacent leading comments and decorators', async () => {
    const { entities } = await facts(
      'a.ts',
      `// Licence header, separated by a blank line.

/** Docs. */
// More docs.
export class Fmt {
  run() {} // trailing comment of run
  /** Docs. */
  @log()
  @trace
  format() {}
}
`,
    );
    expect(spans(entities)).toEqual(['Fmt 3-11', 'Fmt.run 6-6', 'Fmt.format 7-10']);
  });

  it('Java Javadoc and Python comments above decorators', async () => {
    const java = await facts(
      'A.java',
      `/** Docs. */
@Deprecated
public class A { // opening comment
  /** m */
  void m() {}
}
`,
    );
    expect(spans(java.entities)).toEqual(['A 1-6', 'A.m 4-5']);
    const python = await facts(
      'a.py',
      `# Docs for f.
@cache
def f():
    pass
`,
    );
    expect(spans(python.entities)).toEqual(['f 1-4']);
  });

  it('merges overloads into one entity with one member each', async () => {
    const { entities } = await facts(
      'a.ts',
      `function f(a: string): void;
function f(a: number): void;
function f(a: unknown): void {}
`,
    );
    expect(spans(entities)).toEqual(['f 1-1,2-2,3-3']);
    expect(entities[0]!.signature).toBe(
      '(a: string) -> void; (a: number) -> void; (a: unknown) -> void',
    );
  });

  it('names containers and depths, and lists imports and syntax errors', async () => {
    const result = await facts(
      'a.py',
      `import os
class A:
    class B:
        def m(self):
            def inner():
                pass
def broken(:
    pass
`,
    );
    expect(result.entities.map((e) => [e.container, e.name, e.depth])).toEqual([
      [null, 'A', 0],
      ['A', 'B', 1],
      ['A.B', 'm', 2],
      ['A.B.m', 'inner', 3],
      [null, 'broken', 0],
    ]);
    expect(result.imports).toEqual(['os']);
    expect(result.errorLines.length).toBeGreaterThan(0);
    expect(result.errorLines.every((r) => r.startLine >= 7)).toBe(true);
  });

  it('fingerprints code without names, comments or whitespace', async () => {
    const [a, b, c] = (
      await facts(
        'a.ts',
        `function a(x: number) { return x + 1; }
// Moved and renamed.
function b(x: number) {
  return x + 1;
}
function c(x: number) { return x + 2; }
`,
      )
    ).entities;
    expect(a!.contentHash).toBe(b!.contentHash);
    expect(a!.contentHash).not.toBe(c!.contentHash);
    expect(a!.signature).toBe('(x: number)');
  });
});
