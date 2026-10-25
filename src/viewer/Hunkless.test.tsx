// @vitest-environment jsdom
// #127 acceptance: a file change with no hunks (a binary file, a mode-only change, a pure rename)
// can be marked reviewed in every view, counts in the progress badges, and survives export and
// reload as `reviewedFilePaths`.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Fixture, lines } from '../../test/fixtures/fixture.ts';
import { parseContract } from '../schemas/contracts.ts';
import type { ReviewFeedback } from '../schemas/feedback.ts';
import type { ReviewData } from './data.ts';
import { buildModel, groupItemIds } from './model.ts';
import { embedded, fixtureReview, renderEmbedded } from './testing.tsx';

/** A PNG signature followed by bytes that include NUL, so Git treats it as binary. */
const png = (seed: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 64 }, (_, i) => (i * seed) % 256)),
  ]);
const SCRIPT = lines('#!/bin/sh', 'echo deploy');
const GUIDE = lines('# Guide', '', 'Run `npm start`.');

const hunkless: Fixture = {
  name: 'hunkless',
  summary: 'A binary file, a mode-only change and a pure rename, next to one code change.',
  base: {
    'assets/logo.png': png(7),
    'bin/deploy.sh': SCRIPT,
    'docs/old-guide.md': GUIDE,
    'src/banner.ts': lines('export function banner(): string {', "  return 'Shop';", '}'),
  },
  head: {
    'assets/logo.png': png(11),
    'bin/deploy.sh': { mode: '100755', content: SCRIPT },
    'docs/old-guide.md': null,
    'docs/guide.md': GUIDE,
    'src/banner.ts': lines('export function banner(): string {', "  return 'Shop!';", '}'),
  },
  expected: { files: [], nodes: [], edges: [] },
  later: [],
};

/** The hunk-less changes, by path, in the change set's order. */
const PATHS = ['assets/logo.png', 'bin/deploy.sh', 'docs/guide.md'];

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = fixtureReview(hunkless)));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

const show = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const pane = (name: string) => screen.getByRole('region', { name });
const outline = () => screen.getByRole('navigation', { name: 'Review outline' });
const header = () => screen.getByRole('banner');
const hunks = () => data.changeSet.files.reduce((n, f) => n + f.hunks.length, 0);
const label = (path: string) => `Mark ${path} reviewed`;
const checkbox = (container: HTMLElement, name: string) =>
  within(container).getByRole<HTMLInputElement>('checkbox', { name });

/** Whether each hunk-less change shows reviewed in the file and guided views. */
function states() {
  show('Files');
  const files = PATHS.map((p) => checkbox(pane('Files'), label(p)).checked);
  show('Guided');
  const guided = PATHS.map((p) => checkbox(pane('Guided review'), label(p)).checked);
  show('Graph');
  return { files, guided };
}

async function exportFeedback(): Promise<ReviewFeedback> {
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => ((blob = b as Blob), 'blob:x'));
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Export review-feedback.json' }));
  return parseContract('review-feedback', JSON.parse(await blob!.text()));
}

describe('file changes with no hunks', () => {
  it('are the fixture’s binary, mode-only and renamed files, each with a file node', () => {
    const model = buildModel(data);
    expect([...model.hunkless.keys()]).toEqual(PATHS);
    expect(PATHS.map((p) => model.hunkless.get(p)!.status)).toEqual([
      'modified',
      'modified',
      'renamed',
    ]);
    for (const path of PATHS) {
      expect(
        data.graph.nodes.filter((n) => n.path === path && n.hunkIds.length === 0),
      ).toHaveLength(1);
    }
  });

  it('can be marked reviewed in every view, and count in the progress badges', () => {
    renderEmbedded(embedded(data));
    const total = hunks() + PATHS.length;
    expect(header().textContent).toContain(`0/${total} hunks and files reviewed`);
    expect(header().textContent).toContain(`${hunks()}/${hunks()} hunks mapped`);

    // Each says what changed, where its diff would be.
    show('Files');
    const files = pane('Files');
    expect(files.textContent).toContain('Binary file: there is no text diff.');
    expect(files.textContent).toContain('Mode 100644 → 100755. No content changes.');
    expect(files.textContent).toContain('Renamed with no content changes.');

    // The binary file, in the file view.
    fireEvent.click(checkbox(files, label(PATHS[0]!)));
    expect(states()).toEqual({ files: [true, false, false], guided: [true, false, false] });

    // The mode change, in the guided review.
    show('Guided');
    fireEvent.click(checkbox(pane('Guided review'), label(PATHS[1]!)));

    // The rename, in the detail pane after selecting it in the outline.
    fireEvent.click(within(outline()).getAllByText(PATHS[2]!)[0]!);
    const detail = pane('Selected change');
    expect(detail.textContent).toContain('Renamed with no content changes.');
    fireEvent.click(checkbox(detail, label(PATHS[2]!)));
    expect(states()).toEqual({ files: [true, true, true], guided: [true, true, true] });
    expect(header().textContent).toContain(`${PATHS.length}/${total} hunks and files reviewed`);

    // The outline shows each change reviewed.
    for (const path of PATHS) {
      const item = within(outline()).getAllByText(path)[0]!.closest('button')!;
      expect(within(item).getByLabelText('reviewed')).toBeDefined();
    }

    // Unmarking one in the detail pane unmarks it everywhere.
    fireEvent.click(checkbox(detail, label(PATHS[2]!)));
    expect(states()).toEqual({ files: [true, true, false], guided: [true, true, false] });
  });

  it('count in their group, and its checkbox marks them', () => {
    renderEmbedded(embedded(data));
    const model = buildModel(data);
    const node = data.graph.nodes.find((n) => n.path === PATHS[0])!;
    const group = model.homeGroup.get(node.id)!;
    const items = groupItemIds(model, group);
    expect(items).toContain(`file:${PATHS[0]}`);

    fireEvent.click(within(outline()).getByText(group.title));
    fireEvent.click(checkbox(pane('Selected change'), `Mark group ${group.title} reviewed`));
    show('Files');
    expect(checkbox(pane('Files'), label(PATHS[0]!)).checked).toBe(true);
    show('Graph');
    expect(
      within(outline()).getByText(group.title).closest('li')!.querySelector('.group-title')!
        .textContent,
    ).toContain(`✓ ${items.length}/${items.length} reviewed`);

    // On the canvas, the group (expanded by selecting it) shows the binary file's change reviewed.
    const canvas = pane('Canvas');
    const change = within(canvas).getByTitle(PATHS[0]!).closest('.canvas-change')!;
    expect(change.classList.contains('reviewed')).toBe(true);
    expect(change.textContent).toContain('✓ 1/1 reviewed');
  });

  it('are exported as reviewedFilePaths, and kept in the browser until then', async () => {
    renderEmbedded(embedded(data));
    show('Files');
    for (const path of [PATHS[2]!, PATHS[0]!])
      fireEvent.click(checkbox(pane('Files'), label(path)));

    // A reload finds them again.
    cleanup();
    renderEmbedded(embedded(data));
    show('Files');
    expect(PATHS.map((p) => checkbox(pane('Files'), label(p)).checked)).toEqual([
      true,
      false,
      true,
    ]);

    const feedback = await exportFeedback();
    // In the change set's order, whatever order they were marked in.
    expect(feedback.reviewedFilePaths).toEqual([PATHS[0], PATHS[2]]);
    expect(feedback.reviewedHunkIds).toEqual([]);

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
    expect(writeText.mock.calls[0]![0]).toContain(
      `The reviewer marked 0 of ${hunks() === 1 ? '1 hunk' : `${hunks()} hunks`} reviewed (reviewedHunkIds), and 2 of 3 file changes with no hunks`,
    );
  });
});
