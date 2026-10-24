// @vitest-environment jsdom
// Comments and feedback export (#33 acceptance: exported feedback round-trips, so an agent can
// locate every commented line). On a real extraction with a changed function below unchanged
// lines and a renamed file, the reviewer comments on a new-side range, a removed line, expanded
// context and a group. Each exported anchor must lead back, through the snapshot's own file
// content, to exactly the lines the reviewer clicked.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GitRepo, isolatedGitEnv } from '../../test/fixtures/repo.ts';
import { parseContract } from '../schemas/contracts.ts';
import type { LineComment, ReviewFeedback } from '../schemas/feedback.ts';
import type { ReviewData } from './data.ts';
import { contentLines } from './diff.ts';
import { embedded, generateReview, renderEmbedded } from './testing.tsx';

const numbered = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i + 1));

const base = {
  'src/a.ts': [
    ...numbered(30, (i) => `export const v${i} = ${i};`),
    'export function total(x: number): number {',
    '  return x;',
    '}',
    '',
  ].join('\n'),
  'src/old-name.ts': [...numbered(12, (i) => `export const r${i} = ${i};`), ''].join('\n'),
};
const head = {
  'src/a.ts': base['src/a.ts'].replace('  return x;', '  const y = x * 2;\n  return y;'),
  'src/old-name.ts': null,
  'src/new-name.ts': base['src/old-name.ts'].replace('r6 = 6;', 'r6 = 60;'),
};

const root = mkdtempSync(join(tmpdir(), 'bcr-comments-'));
let data: ReviewData;

beforeAll(() => {
  const dir = join(root, 'repo');
  mkdirSync(dir);
  const repo = new GitRepo(dir, { ...process.env, ...isolatedGitEnv(join(root, 'no-config')) });
  const baseCommit = repo.commit([], base);
  data = generateReview(dir, repo.commit([baseCommit], head), join(root, 'out'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

const pane = (name: string) => screen.getByRole('region', { name });
const outline = () => screen.getByRole('navigation', { name: 'Review outline' });

function selectNode(path: string) {
  const node = data.graph.nodes.find((n) => n.path === path && n.hunkIds.length > 0)!;
  fireEvent.click(within(outline()).getAllByText(node.displayName)[0]!);
  return node;
}

/** Clicks the line numbers of `lines` on `side`, the first plainly and the last with shift. */
function pickLines(side: 'old' | 'new', first: number, last = first): string[] {
  const detail = pane('Selected change');
  fireEvent.click(within(detail).getByRole('button', { name: `Comment on ${side} line ${first}` }));
  if (last !== first) {
    const button = within(detail).getByRole('button', { name: `Comment on ${side} line ${last}` });
    fireEvent.click(button, { shiftKey: true });
  }
  return [...detail.querySelectorAll('tr.selected .code')].map((td) => td.textContent);
}

function write(label: RegExp | string, body: string) {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

/** Clicks the export button and returns the downloaded file, parsed as the contract. */
async function exportFeedback(): Promise<ReviewFeedback> {
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((blob = b as Blob), 'blob:x'));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Export review-feedback.json' }));
  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('review-feedback.json');
  return parseContract('review-feedback', JSON.parse(await blob!.text()));
}

/** The lines a comment's anchor names, read from the snapshot's content of that side. */
function locate(comment: LineComment): string[] {
  const file = data.changeSet.files.find(
    (f) => (comment.side === 'old' ? f.oldPath : f.newPath) === comment.path,
  )!;
  const content = comment.side === 'old' ? file.oldContent : file.newContent;
  return contentLines(content!).slice(comment.range.startLine - 1, comment.range.endLine);
}

/** Writes the four comments the tests share, and returns the lines each line comment was on. */
function writeComments() {
  const total = selectNode('src/a.ts');
  const hunk = data.changeSet.files.find((f) => f.newPath === 'src/a.ts')!.hunks[0]!;
  const range = pickLines('new', 32, 33);
  write('Comment on new lines 32-33', 'Name y for what it is.');
  const removed = pickLines('old', 32);
  write('Comment on old line 32', 'Why was this wrong?');
  const detail = pane('Selected change');
  fireEvent.click(within(detail).getAllByRole('button', { name: /^(Show|Show all)$/ })[0]!);
  const context = pickLines('new', 2);
  write('Comment on new line 2', 'Unrelated, but v2 is unused.');

  const renamed = selectNode('src/new-name.ts');
  const renamedOld = pickLines('old', 6);
  write('Comment on old line 6', 'Keep 6.');

  const group = data.plan.groups[0]!;
  fireEvent.click(within(outline()).getByText(group.title));
  fireEvent.click(screen.getByRole('button', { name: 'Comment on this group' }));
  write('Comment on this group', 'Split this group.');
  return { total, hunk, renamed, group, lines: [range, removed, context, renamedOld] };
}

describe('comments', () => {
  it('export anchors that lead back to every commented line', async () => {
    renderEmbedded(embedded(data));
    const { total, hunk, renamed, group, lines } = writeComments();
    expect(lines.map((l) => l.length)).toEqual([2, 1, 1, 1]);

    const feedback = await exportFeedback();
    expect(feedback.snapshotId).toBe(data.changeSet.snapshotId);
    const lineComments = feedback.comments.filter((c) => c.kind === 'line');
    expect(lineComments.map(locate)).toEqual(lines);
    expect(
      lineComments.map(({ path, side, hunkId, nodeId }) => [path, side, hunkId, nodeId]),
    ).toEqual([
      ['src/a.ts', 'new', hunk.id, total.id],
      ['src/a.ts', 'old', hunk.id, total.id],
      ['src/a.ts', 'new', null, null],
      ['src/old-name.ts', 'old', renamed.hunkIds[0], renamed.id],
    ]);
    expect(feedback.comments.at(-1)).toEqual({
      id: 'c5',
      kind: 'group',
      groupId: group.id,
      body: 'Split this group.',
    });
  });

  it('copies the feedback for an agent: locations in words, then the same JSON', async () => {
    renderEmbedded(embedded(data));
    writeComments();
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy feedback for agent' }));
        await Promise.resolve();
      });
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain(`snapshot ${data.changeSet.snapshotId}`);
    expect(text).toContain('1. src/a.ts:32-33 (new side, in total)\n   Name y for what it is.');
    expect(text).toContain('3. src/a.ts:2 (new side)\n');
    expect(text).toContain('4. src/old-name.ts:6 (old side, in ');
    expect(text).toContain(`5. Group "${data.plan.groups[0]!.title}"`);
    const json = /```json\n([\s\S]*)```\n$/.exec(text)![1]!;
    const copied = parseContract('review-feedback', JSON.parse(json));
    expect(copied).toEqual(await exportFeedback());
    expect(screen.getByRole('status').textContent).toBe('Downloaded review-feedback.json');
  });

  it('shows the same comments wherever the diff is shown, and on expanded context again', () => {
    renderEmbedded(embedded(data));
    const { hunk } = writeComments();
    selectNode('src/a.ts');
    const detail = pane('Selected change');
    for (const body of ['Name y for what it is.', 'Why was this wrong?', 'Unrelated, but v2']) {
      expect(within(detail).getByText(body, { exact: false })).toBeTruthy();
    }
    fireEvent.click(within(detail).getByRole('button', { name: /^@@ -/ }));
    expect(pane('Selected change').querySelector(`[data-hunk-id="${hunk.id}"]`)).not.toBeNull();
    expect(within(pane('Selected change')).getByText('Why was this wrong?')).toBeTruthy();
  });

  it('edits and deletes comments', async () => {
    renderEmbedded(embedded(data));
    selectNode('src/a.ts');
    pickLines('new', 33);
    write('Comment on new line 33', 'First');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    write('Edit comment', '  Second  ');
    expect(screen.getByText('Second')).toBeTruthy();
    expect((await exportFeedback()).comments.map((c) => c.body)).toEqual(['Second']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByText('Second')).toBeNull();
    expect(screen.getByRole('banner').textContent).toContain('0 comments');
  });

  it('keeps comments in the browser on a best-effort basis, and warns until they are exported', async () => {
    renderEmbedded(embedded(data));
    const header = () => screen.getByRole('banner');
    expect(header().textContent).not.toContain('not exported');
    writeComments();
    expect(header().textContent).toContain('5 comments');
    expect(header().textContent).toContain('not exported');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    // A reload finds them again, still not exported.
    cleanup();
    renderEmbedded(embedded(data));
    expect(header().textContent).toContain('5 comments');
    expect(header().textContent).toContain('not exported');

    await exportFeedback();
    expect(header().textContent).not.toContain('not exported');
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('works when the browser keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    renderEmbedded(embedded(data));
    selectNode('src/a.ts');
    pickLines('new', 33);
    write('Comment on new line 33', 'Still here');
    expect(screen.getByText('Still here')).toBeTruthy();
  });
});
