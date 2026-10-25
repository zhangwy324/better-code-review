// @vitest-environment jsdom
// The diff component (#29 acceptance: every hunk renders byte-for-byte from the ChangeSet) on a real
// extraction of awkward content: tabs, trailing whitespace, CRLF, no newline at the end, unicode,
// a very long line and HTML-looking text. Expanded context must be the file's own unchanged lines,
// with the right numbers on both sides, and never a changed line.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo, isolatedGitEnv } from '../../test/fixtures/repo.ts';
import type { ChangeSet, FileChange } from '../schemas/changeset.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { Diff } from './Diff.tsx';
import { contentLines, hiddenChars, lineDigits } from './diff.ts';
import { lineCounts } from './model.ts';
import { generateReview } from './testing.tsx';

const numbered = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1));

const html = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
const long = `const long = "${'x'.repeat(20_000)}";`;
// Each kind of hidden character (#106), with emoji whose joiner and selector are not hidden.
const hidden =
  "export const w20 = '\u2067a\u200bb\u200cc\u200dd\u2060e\ufefff\u00adg\u3164\u{e0041}\ufe00\ufe01 👨\u200d👩 ❤\ufe0f';";

const base = {
  // Three hunks with unchanged lines between them, and a multi-line comment around the first.
  'src/tricky.ts': [
    '/* A comment',
    '   over several lines */',
    ...numbered(40, (i) => `export const v${i} = ${i};`),
    '\tconst tabbed = 1;',
    'const trailing = 2;   ',
    `const html = '${html}';`,
    ...numbered(30, (i) => `export const w${i} = 'é ü ✓ 🙂 مرحبا';`),
    long,
    '',
  ].join('\n'),
  'crlf.txt': numbered(30, (i) => `line ${i}\r\n`).join(''),
  'no-eol.py': numbered(12, (i) => `x${i} = ${i}`).join('\n'),
  'gone.py': 'def gone():\n    return 1\n',
  'latin1.txt': Buffer.from('caf\xe9\n', 'latin1'),
};
const head = {
  'src/tricky.ts': base['src/tricky.ts']
    .replace('   over several lines */', '   over several changed lines */')
    .replace('\tconst tabbed = 1;', '\tconst tabbed = 1;\t\t')
    .replace('const trailing = 2;   ', 'const trailing = 3;   ')
    .replace(`'${html}'`, `'${html} changed'`)
    .replace("export const w15 = 'é ü ✓ 🙂 مرحبا';", "export const w15 = 'ß 你好 ​';")
    .replace("export const w20 = 'é ü ✓ 🙂 مرحبا';", hidden)
    .replace(long, `${long} // changed`),
  'crlf.txt': base['crlf.txt'].replace('line 15\r\n', 'line 15 changed\r\n'),
  'no-eol.py': `${base['no-eol.py']}\nx13 = 13`,
  'gone.py': null,
  'added.py': 'def added():\n    return "<b>bold</b>"\n',
  'latin1.txt': Buffer.from('caf\xe9 au lait\n', 'latin1'),
};

const root = mkdtempSync(join(tmpdir(), 'bcr-diff-'));
let changeSet: ChangeSet;
let graph: ChangeGraph;

beforeAll(() => {
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const repo = new GitRepo(dir, {
    ...process.env,
    ...isolatedGitEnv(join(root, 'no-global-config')),
  });
  repo.git('config', 'core.autocrlf', 'false');
  const baseCommit = repo.commit([], base);
  const headCommit = repo.commit([baseCommit], head);
  ({ changeSet, graph } = generateReview(dir, headCommit, join(root, 'out')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(cleanup);

function file(path: string): FileChange {
  return changeSet.files.find((f) => (f.newPath ?? f.oldPath) === path)!;
}

function renderDiff(f: FileChange, hunkIds?: string[]) {
  const path = (f.newPath ?? f.oldPath)!;
  const language = graph.files.find((g) => g.path === path)?.language ?? null;
  return render(<Diff file={f} hunkIds={hunkIds} language={language} />);
}

/** The text a hunk's rows show: the `@@` line, then each row's prefix and code, one per line. */
function shownPatch(tbody: Element): string {
  return [...tbody.querySelectorAll('tr')]
    .map((tr) => {
      const cells = tr.querySelectorAll('td');
      return tr.classList.contains('hunk-header')
        ? cells[1]!.textContent
        : cells[2]!.textContent + cells[3]!.textContent;
    })
    .map((line) => `${line}\n`)
    .join('');
}

/** Each code row: its classes and line numbers, and its text. */
function codeRows(container: HTMLElement) {
  return [...container.querySelectorAll('tr[data-old-line], tr[data-new-line]')].map((tr) => ({
    kind: tr.className,
    old: tr.hasAttribute('data-old-line') ? Number(tr.getAttribute('data-old-line')) : null,
    new: tr.hasAttribute('data-new-line') ? Number(tr.getAttribute('data-new-line')) : null,
    text: tr.querySelector('.code')!.textContent,
  }));
}

/** Clicks "Show" and "Show all" until no unchanged line is hidden. */
function expandAll(container: HTMLElement) {
  for (let button = find(); button !== undefined; button = find()) fireEvent.click(button);
  function find() {
    return [...container.querySelectorAll<HTMLButtonElement>('.expand button')].find((b) =>
      /^Show( all)?$/.test(b.textContent),
    );
  }
}

describe('Diff', () => {
  it('extracts the awkward content this test is about', () => {
    const patches = changeSet.files.flatMap((f) => f.hunks.map((h) => h.patch)).join('');
    for (const expected of ['\t\t\n', '   \n', '\r\n', '\\ No newline at end of file', html]) {
      expect(patches).toContain(expected);
    }
    expect(file('src/tricky.ts').hunks.length).toBeGreaterThan(2);
    expect(file('latin1.txt').contentOmitted).toBe('not-utf8');
  });

  it('renders every hunk byte-for-byte from the ChangeSet', () => {
    for (const f of changeSet.files) {
      const { container, unmount } = renderDiff(f);
      const bodies = [...container.querySelectorAll('tbody.hunk')];
      expect(bodies.map((b) => b.getAttribute('data-hunk-id'))).toEqual(f.hunks.map((h) => h.id));
      bodies.forEach((body, i) => expect(shownPatch(body)).toBe(f.hunks[i]!.patch));
      expect(container.querySelector('img, script, b')).toBeNull();
      unmount();
    }
    expect((globalThis as { pwned?: unknown }).pwned).toBeUndefined();
  });

  it('counts the added and removed lines the diff shows, over all of a file’s hunks', () => {
    for (const f of changeSet.files) {
      const { container, unmount } = renderDiff(f);
      const kinds = codeRows(container).map((r) => r.kind.split(' '));
      expect(lineCounts(f.hunks)).toEqual({
        added: kinds.filter((k) => k.includes('added')).length,
        removed: kinds.filter((k) => k.includes('removed')).length,
      });
      unmount();
    }
    expect(lineCounts([])).toEqual({ added: 0, removed: 0 });
  });

  it('expands unchanged lines up to the whole file, numbered on both sides', () => {
    for (const path of ['src/tricky.ts', 'crlf.txt', 'no-eol.py']) {
      const f = file(path);
      const { container, unmount } = renderDiff(f);
      const before = codeRows(container).length;
      expandAll(container);
      const rows = codeRows(container);
      expect(rows.length).toBeGreaterThan(before);

      // Every line of the new file shows once, in order, and every old line is accounted for.
      const newLines = contentLines(f.newContent!);
      const oldLines = contentLines(f.oldContent!);
      const onNew = rows.filter((r) => r.new !== null);
      expect(onNew.map((r) => r.new)).toEqual(newLines.map((_, i) => i + 1));
      expect(onNew.map((r) => r.text)).toEqual(newLines);
      const onOld = rows.filter((r) => r.old !== null);
      expect(onOld.map((r) => r.old)).toEqual(oldLines.map((_, i) => i + 1));
      expect(onOld.map((r) => r.text)).toEqual(oldLines);
      unmount();
    }
  });

  it('never shows a changed line as context when only some hunks are shown', () => {
    const f = file('src/tricky.ts');
    const middle = f.hunks[1]!;
    const { container } = renderDiff(f, [middle.id]);
    expect(container.querySelectorAll('tbody.hunk')).toHaveLength(1);
    expandAll(container);
    const oldLines = contentLines(f.oldContent!);
    const newLines = contentLines(f.newContent!);
    const expanded = codeRows(container).filter((r) => r.kind.includes('expanded'));
    expect(expanded.length).toBeGreaterThan(0);
    for (const row of expanded) {
      expect(row.text).toBe(oldLines[row.old! - 1]);
      expect(row.text).toBe(newLines[row.new! - 1]);
    }
    // The neighbouring hunks' lines are not among them.
    const first = f.hunks[0]!;
    expect(expanded.every((r) => r.new! > first.newStart + first.newLines - 1)).toBe(true);
    expect(container.textContent).not.toContain('other hunk');
  });

  it('marks the hunks left out between shown ones', () => {
    const f = file('src/tricky.ts');
    const { container } = renderDiff(f, [f.hunks[0]!.id, f.hunks.at(-1)!.id]);
    expect(container.querySelector('.skipped')!.textContent).toBe(
      `⋯ ${f.hunks.length - 2} other hunk${f.hunks.length === 3 ? '' : 's'}`,
    );
  });

  it('highlights syntax from the whole file without changing the text', () => {
    const { container } = renderDiff(file('src/tricky.ts'));
    const comment = codeRows(container).find((r) => r.text.includes('several changed lines'))!;
    expect(comment.kind).toBe('added');
    const row = container.querySelector('tr.added .tok-comment');
    expect(row?.textContent).toBe('   over several changed lines */');
    expect(container.querySelector('.tok-keyword')?.textContent).toBe('export');
    const trailing = [...container.querySelectorAll('.trailing-ws')].map((e) => e.textContent);
    expect(trailing).toEqual(expect.arrayContaining(['\t\t', '   ']));
  });

  it('marks each bidirectional control and invisible character, keeping the text', () => {
    const { container } = renderDiff(file('src/tricky.ts'));
    const row = codeRows(container).find((r) => r.text === hidden);
    expect(row?.kind).toBe('added');
    const tr = container.querySelector(`tr[data-new-line="${row!.new}"]`)!;
    const marks = [...tr.querySelectorAll('.bidi, .invisible')].map((m) => [
      m.className,
      m.getAttribute('data-code'),
      m.getAttribute('title'),
    ]);
    expect(marks).toEqual([
      ['bidi', 'U+2067', 'Bidirectional control U+2067'],
      ...['200B', '200C', '200D', '2060', 'FEFF', '00AD', '3164', 'E0041', 'FE00', 'FE01'].map(
        (c) => ['invisible', `U+${c}`, `Invisible character U+${c}`],
      ),
    ]);
    // The file has one more: the zero-width space of line w15, and the note counts both lines.
    expect(container.querySelector('.hidden-note')!.textContent).toMatch(/^12 hidden characters /);
  });

  it('marks CRLF line ends, keeping the carriage return in the text', () => {
    const { container } = renderDiff(file('crlf.txt'));
    const crs = container.querySelectorAll('.code > .cr');
    expect(crs.length).toBe(codeRows(container).length);
    expect([...crs].every((cr) => cr.textContent === '\r')).toBe(true);
    // A line ending isn't trailing whitespace.
    expect(container.querySelector('.trailing-ws')).toBeNull();
  });

  it('sizes the gutter for the widest line number on either side', () => {
    // The gutter is sticky (#107), so its columns have fixed widths, from the digits.
    const f = file('src/tricky.ts');
    expect(lineDigits(f)).toBe(String(contentLines(f.newContent!).length).length);
    const { container } = renderDiff(f);
    expect(
      container.querySelector<HTMLElement>('.diff-table')!.style.getPropertyValue('--line-digits'),
    ).toBe('3');
    // An old file longer than every hunk and the new file still fits.
    const shrunk = { ...f, oldContent: 'x\n'.repeat(12_345), hunks: f.hunks.slice(0, 1) };
    expect(lineDigits(shrunk)).toBe(5);
    expect(lineDigits({ ...f, oldContent: null, newContent: null })).toBe(
      String(Math.max(...f.hunks.map((h) => h.newStart + h.newLines))).length,
    );
  });

  it('says when context is unavailable, and shows the patch alone', () => {
    const f = file('latin1.txt');
    const { container } = renderDiff(f);
    expect(container.querySelector('.note')!.textContent).toMatch(/not valid UTF-8/);
    expect(container.querySelector('.expand')).toBeNull();
    expect(shownPatch(container.querySelector('tbody.hunk')!)).toBe(f.hunks[0]!.patch);
  });
});

describe('hiddenChars', () => {
  const codes = (text: string) => hiddenChars(text).map((h) => `${h.kind} ${h.code}`);

  it('finds bidirectional controls', () => {
    const bidi = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    expect(codes(`a${bidi}b`)).toEqual(
      [...bidi].map((c) => `bidi U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`),
    );
  });

  it('finds zero-width and other invisible characters, with their positions', () => {
    expect(hiddenChars('a\u200bb\u{e0041}c')).toEqual([
      { index: 1, length: 1, kind: 'invisible', code: 'U+200B' },
      { index: 3, length: 2, kind: 'invisible', code: 'U+E0041' },
    ]);
    const each =
      '\u00ad\u034f\u115f\u1160\u180e\u200b\u200c\u200d\u2060\u2064\u206a\u206f\u3164\ufeff\uffa0\ufff9\ufffb';
    expect(codes(each)).toHaveLength([...each].length);
    expect(codes('x\u{e007f}\u{e0100}\u{e01ef}')).toEqual([
      'invisible U+E007F',
      'invisible U+E0100',
      'invisible U+E01EF',
    ]);
  });

  it('leaves alone emoji joiners and single variation selectors, but not a run of selectors', () => {
    expect(codes('👨\u200d👩\u200d👧 👍🏽\u200d🔥 ❤\ufe0f ✓\ufe0e')).toEqual([]);
    expect(codes('a\u200d👩 👨\u200db')).toEqual(['invisible U+200D', 'invisible U+200D']);
    expect(codes('a\ufe00\ufe0f\ufe05')).toEqual([
      'invisible U+FE00',
      'invisible U+FE0F',
      'invisible U+FE05',
    ]);
  });

  it('finds nothing in ordinary text, whitespace or unicode', () => {
    expect(codes("\tconst s = 'é ü ✓ 🙂 مرحبا 你好';   \r")).toEqual([]);
  });
});
