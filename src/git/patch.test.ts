import { describe, expect, it } from 'vitest';
import { headerPath, hunkLines, parsePatch } from './patch.ts';

const PATCH = [
  'diff --git a/src/a b.ts b/src/a b.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a b.ts',
  '+++ b/src/a b.ts',
  '@@ -1,2 +1,2 @@ header context',
  ' keep',
  '-old',
  '+new',
  '@@ -10 +10,0 @@',
  '-gone',
  'diff --git a/img.png b/img.png',
  'index 3333333..4444444 100644',
  'Binary files a/img.png and b/img.png differ',
  'diff --git a/last b/last',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/last',
  '@@ -0,0 +1 @@',
  '+no newline',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parsePatch', () => {
  it('splits files and hunks, keeping hunk text exactly', () => {
    const sections = parsePatch(PATCH);
    expect(sections.map((s) => [s.oldPath, s.newPath, s.binary, s.hunks.length])).toEqual([
      ['src/a b.ts', 'src/a b.ts', false, 2],
      ['img.png', 'img.png', true, 0],
      ['last', 'last', false, 1],
    ]);
    const hunks = sections.flatMap((s) => s.hunks);
    expect(hunks[0]).toEqual({
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      patch: '@@ -1,2 +1,2 @@ header context\n keep\n-old\n+new\n',
    });
    // An omitted count means 1.
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 0 });
    expect(hunks[2]?.patch).toBe('@@ -0,0 +1 @@\n+no newline\n\\ No newline at end of file\n');
  });

  it('takes the paths of a rename from its rename headers, quoted or not', () => {
    const renames = [
      'diff --git a/a b/c b/d',
      'similarity index 100%',
      'rename from a b',
      'rename to c b/d',
      'diff --git "a/na\\303\\257ve" b/plain',
      'similarity index 80%',
      'rename from "na\\303\\257ve"',
      'rename to plain',
      'index 1111111..2222222 100644',
      '--- "a/na\\303\\257ve"',
      '+++ b/plain',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    expect(parsePatch(renames).map((s) => [s.oldPath, s.newPath, s.hunks.length])).toEqual([
      ['a b', 'c b/d', 0],
      ['naïve', 'plain', 1],
    ]);
    expect(() => parsePatch('diff --git a/x b/y\nrename from x\n')).toThrow(/Incomplete rename/);
  });

  it('rejects hunks whose body disagrees with the header', () => {
    expect(() => parsePatch('diff --git a/x b/x\n@@ -1,2 +1 @@\n-a\n+b\n')).toThrow(/header says/);
    expect(() => parsePatch('@@ -1 +1 @@\n')).toThrow(/before the first file header/);
  });
});

describe('headerPath', () => {
  it('reads unquoted paths, including spaces', () => {
    expect(headerPath('diff --git a/x y/z b/x y/z\n')).toBe('x y/z');
    expect(headerPath('diff --git a/b b/b')).toBe('b');
  });

  it('unquotes C-style quoted paths', () => {
    expect(headerPath('diff --git "a/na\\303\\257ve/q\\"t\\tx" "b/na\\303\\257ve/q\\"t\\tx"')).toBe(
      'naïve/q"t\tx',
    );
  });

  it('rejects headers whose two names differ', () => {
    expect(() => headerPath('diff --git a/x b/y')).toThrow(/Unexpected diff header/);
    expect(() => headerPath('diff --git "a/x" "b/y"')).toThrow(/Unexpected diff header/);
  });
});

describe('hunkLines', () => {
  it('numbers old and new lines and skips the no-newline marker', () => {
    const patch = '@@ -4,3 +4,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n';
    expect(hunkLines({ oldStart: 4, newStart: 4, patch })).toEqual([
      { kind: 'context', oldLine: 4, newLine: 4, text: 'a' },
      { kind: 'removed', oldLine: 5, newLine: null, text: 'b' },
      { kind: 'added', oldLine: null, newLine: 5, text: 'B' },
      { kind: 'context', oldLine: 6, newLine: 6, text: 'c' },
    ]);
  });
});
