// @vitest-environment jsdom
// #31 acceptance: the guided review follows the plan's order and nesting, the file view reaches
// every hunk whatever the plan says, and switching views keeps the selection and the canvas.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReviewData } from './data.ts';
import { Highlighter } from './highlight.ts';
import { embedded, renderEmbedded, signatureReview } from './testing.tsx';

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = signatureReview()));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const show = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const shownHunkIds = (pane: HTMLElement) =>
  new Set(
    [...pane.querySelectorAll('tbody[data-hunk-id]')].map((e) => e.getAttribute('data-hunk-id')),
  );
const allHunkIds = () => data.changeSet.files.flatMap((f) => f.hunks.map((h) => h.id));

describe('Views', () => {
  it('shows the groups in reading order, nested, with each home change’s diff', () => {
    // Nest the second group in the first, to check the hierarchy.
    const [first, second, ...rest] = data.plan.groupOrder;
    const plan = {
      ...data.plan,
      groupOrder: [first!, ...rest],
      groups: data.plan.groups.map((g) =>
        g.id === first ? { ...g, childGroupIds: [...g.childGroupIds, second!] } : g,
      ),
    };
    renderEmbedded(embedded({ ...data, plan }));
    show('Guided');
    const guided = screen.getByRole('region', { name: 'Guided review' });

    const top = [...guided.querySelectorAll(':scope > ol > [data-group-id]')];
    expect(top.map((e) => e.getAttribute('data-group-id'))).toEqual(plan.groupOrder);
    const child = top[0]!.querySelector(`ol > [data-group-id="${second}"]`);
    expect(child).not.toBeNull();

    for (const group of plan.groups) {
      const section = guided.querySelector(`[data-group-id="${group.id}"]`)!;
      for (const id of group.nodeIds) {
        const node = data.graph.nodes.find((n) => n.id === id)!;
        const article = section.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
        expect(article.querySelector('h4 button')!.textContent).toBe(node.displayName);
        expect(shownHunkIds(article)).toEqual(new Set(node.hunkIds));
      }
    }
  });

  it('reaches every hunk from the file view, even with a plan that has no groups', () => {
    const plan = { ...data.plan, groups: [], groupOrder: [] };
    renderEmbedded(embedded({ ...data, plan }));
    show('Files');
    const files = screen.getByRole('region', { name: 'Files' });

    expect(shownHunkIds(files)).toEqual(new Set(allHunkIds()));
    for (const file of data.changeSet.files) {
      expect(files.querySelector(`[data-path="${file.newPath ?? file.oldPath}"]`)).not.toBeNull();
    }
    // Each hunk opens in the detail pane.
    const hunk = data.changeSet.files[0]!.hunks[0]!;
    fireEvent.click(within(files).getAllByText(hunk.patch.split('\n')[0]!)[0]!);
    const detail = screen.getByRole('region', { name: 'Selected change' });
    expect(detail.querySelector(`tbody[data-hunk-id="${hunk.id}"]`)).not.toBeNull();
  });

  it('keeps the selection and the canvas when switching views', () => {
    renderEmbedded(embedded(data));
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    const detail = screen.getByRole('region', { name: 'Selected change' });
    const group = data.plan.groups.find((g) => g.nodeIds.length > 0)!;
    const node = data.graph.nodes.find((n) => n.id === group.nodeIds[0])!;

    // Selecting the change in the outline expands its group on the canvas.
    fireEvent.click(within(outline).getAllByText(node.displayName)[0]!);
    const canvas = screen.getByRole('region', { name: 'Canvas' });
    expect(canvas.querySelector('.canvas-change[aria-current]')!.textContent).toContain(
      node.displayName,
    );

    show('Guided');
    const guided = screen.getByRole('region', { name: 'Guided review' });
    expect(guided.querySelector(`[data-node-id="${node.id}"]`)!.hasAttribute('aria-current')).toBe(
      true,
    );
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(node.displayName);

    show('Files');
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(node.displayName);

    // Back on the canvas, the group is still expanded and the change still selected.
    show('Graph');
    expect(screen.getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe('true');
    const again = screen.getByRole('region', { name: 'Canvas' });
    expect(again.querySelector('.canvas-change[aria-current]')!.textContent).toContain(
      node.displayName,
    );
  });

  it('parses each file once for all the views that show it', () => {
    const parse = vi.spyOn(Highlighter, 'for');
    renderEmbedded(embedded(data));
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    fireEvent.click(within(outline).getAllByText(data.graph.nodes[0]!.displayName)[0]!);
    show('Guided');
    show('Files');

    // The node's file is in the detail pane, the guided review and the file view.
    const sides = data.changeSet.files.flatMap((f) => [f.oldContent, f.newContent]);
    expect(parse.mock.calls.length).toBe(sides.filter((c) => c !== null).length);
  });
});
