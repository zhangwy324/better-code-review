// @vitest-environment jsdom
// The diff component (#29 acceptance: every hunk renders byte-for-byte from the ChangeSet) on a real
// extraction of awkward content: tabs, trailing whitespace, CRLF, no newline at the end, unicode,
// a very long line and HTML-looking text. Expanded context must be the file's own unchanged lines,
// with the right numbers on both sides, and never a changed line. `generate` runs in a child
// process, as in App.test.tsx.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo, isolatedGitEnv } from '../../test/fixtures/repo.ts';
import type { ChangeSet, FileChange } from '../schemas/changeset.ts';
import type { ChangeGraph } from '../schemas/graph.ts';
import { Diff } from './Diff.tsx';
import { contentLines } from './diff.ts';

const numbered = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1));

const html = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
const long = `const long = "${'x'.repeat(20_000)}";`;

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
  const out = join(root, 'out');
  const main = join(import.meta.dirname, '..', 'cli', 'main.ts');
  execFileSync(
    process.execPath,
    [main, 'generate', '--commit', headCommit, '--no-lsp', '--out', out],
    { cwd: dir, stdio: 'ignore' },
  );
  const read = (file: string): unknown => JSON.parse(readFileSync(join(out, file), 'utf8'));
  changeSet = read('changes.json') as ChangeSet;
  graph = read('graph.json') as ChangeGraph;
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

  it('marks CRLF line ends, keeping the carriage return in the text', () => {
    const { container } = renderDiff(file('crlf.txt'));
    const crs = container.querySelectorAll('.code > .cr');
    expect(crs.length).toBe(codeRows(container).length);
    expect([...crs].every((cr) => cr.textContent === '\r')).toBe(true);
    // A line ending isn't trailing whitespace.
    expect(container.querySelector('.trailing-ws')).toBeNull();
  });

  it('says when context is unavailable, and shows the patch alone', () => {
    const f = file('latin1.txt');
    const { container } = renderDiff(f);
    expect(container.querySelector('.note')!.textContent).toMatch(/not valid UTF-8/);
    expect(container.querySelector('.expand')).toBeNull();
    expect(shownPatch(container.querySelector('tbody.hunk')!)).toBe(f.hunks[0]!.patch);
  });
});
