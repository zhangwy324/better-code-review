// @vitest-environment jsdom
// #30 acceptance: the root change points to its changed callers; the unchanged caller is absent.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UNCHANGED_CALLERS_NOTE } from '../text/index.ts';
import {
  type CanvasItem,
  canvasGraph,
  changeItemId,
  type GroupItem,
  groupItemId,
  SIZES,
  stableLayout,
} from './canvas.ts';
import type { ReviewData } from './data.ts';
import { buildModel } from './model.ts';
import { embedded, renderEmbedded, signatureReview } from './testing.tsx';

let data: ReviewData;
let dispose: () => void;

beforeAll(() => ({ data, dispose } = signatureReview()));
afterAll(() => dispose());
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Canvas', () => {
  const nodeId = (name: string) => data.graph.nodes.find((n) => n.displayName === name)?.id;
  const callers = ['checkoutSummary', 'invoiceSummary', 'receiptSummary'];

  it('starts with one collapsed node per group, in reading order', () => {
    const model = buildModel(data);
    const { items } = canvasGraph(model, new Set());
    expect(items.map((i) => [i.type, i.id])).toEqual(
      data.plan.groupOrder.map((id) => ['collapsed', groupItemId(id)]),
    );
    expect(items.map((i) => i.data)).toEqual(
      data.plan.groupOrder.map((groupId, i) => ({ groupId, order: i + 1 })),
    );
    // Laid out apart, not on top of each other.
    const positions = new Set(items.map((i) => `${i.position.x},${i.position.y}`));
    expect(positions.size).toBe(items.length);
  });

  it('draws the root change to its changed callers, and no unchanged caller', () => {
    const model = buildModel(data);
    const { items, edges } = canvasGraph(model, new Set(data.plan.groupOrder));
    expect(nodeId('emailSummary')).toBeUndefined();
    expect(items.filter((i) => i.type === 'change')).toHaveLength(data.graph.nodes.length);

    const root = changeItemId(nodeId('formatPrice')!);
    for (const caller of callers) {
      const edge = edges.find((e) => e.target === changeItemId(nodeId(caller)!));
      expect(edge).toMatchObject({
        source: root,
        data: { style: 'possible', label: 'called by' },
      });
    }
    // Every member sits inside its group's box.
    for (const item of items.filter((i) => i.type === 'change')) {
      const home = model.homeGroup.get(item.data.nodeId)!;
      expect(item.parentId).toBe(groupItemId(home.id));
    }
  });

  it('aggregates the edges between collapsed groups', () => {
    const root = nodeId('formatPrice')!;
    const plan = {
      ...data.plan,
      groups: [
        ...data.plan.groups.map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => id !== root) })),
        { ...data.plan.groups[0]!, id: 'contract', title: 'Contract', nodeIds: [root] },
      ],
      groupOrder: ['contract', ...data.plan.groupOrder],
    };
    const model = buildModel({ ...data, plan });
    const home = model.homeGroup.get(nodeId('checkoutSummary')!)!;
    const callerEdges = data.graph.codeEdges.filter(
      (e) => e.to === root && model.homeGroup.get((e as { from: string }).from) === home,
    );

    const { edges } = canvasGraph(model, new Set());
    expect(edges).toEqual([
      expect.objectContaining({
        source: groupItemId('contract'),
        target: groupItemId(home.id),
        data: {
          linkIds: callerEdges.map((e) => e.id),
          style: 'possible',
          label: `called by ×${callerEdges.length}`,
        },
      }),
    ]);
  });

  it('says that unchanged callers are not analysed, and expands groups on demand', () => {
    renderEmbedded(embedded(data));
    const canvas = screen.getByRole('region', { name: 'Canvas' });
    expect(within(canvas).getByText(UNCHANGED_CALLERS_NOTE)).toBeTruthy();
    for (const group of data.plan.groups)
      expect(within(canvas).getByText(group.title)).toBeTruthy();
    expect(within(canvas).queryByText('formatPrice')).toBeNull();

    const group = model().homeGroup.get(nodeId('formatPrice')!)!;
    fireEvent.click(within(canvas).getByLabelText(`Expand ${group.title}`));
    for (const name of ['formatPrice', ...callers]) {
      expect(within(canvas).getByText(name)).toBeTruthy();
    }
    expect(within(canvas).queryByText('emailSummary')).toBeNull();
    fireEvent.click(within(canvas).getByLabelText(`Collapse ${group.title}`));
    expect(within(canvas).queryByText('formatPrice')).toBeNull();
  });

  it('navigates along edges and shows their evidence and direction', () => {
    renderEmbedded(embedded(data));
    const outline = screen.getByRole('navigation', { name: 'Review outline' });
    const detail = screen.getByRole('region', { name: 'Selected change' });
    fireEvent.click(within(outline).getByText('checkoutSummary'));

    const related = within(detail).getByText('Related changes').nextElementSibling as HTMLElement;
    expect(related.textContent).toBe('calls formatPrice possible');
    fireEvent.click(within(related).getByText('possible'));
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe(
      'checkoutSummary calls formatPrice',
    );
    expect(detail.textContent).toContain('Possible: found by text search, not verified');
    expect(detail.textContent).toMatch(
      /text-search · candidate · call · src\/checkout\.ts:\d+ \(new\)/,
    );

    fireEvent.click(within(detail).getByText('formatPrice'));
    expect(within(detail).getAllByRole('heading')[0]!.textContent).toBe('formatPrice');
    const fromRoot = within(detail).getByText('Related changes').nextElementSibling!;
    for (const caller of callers) expect(fromRoot.textContent).toContain(`called by ${caller}`);
  });

  const model = () => buildModel(data);
});

describe('stableLayout', () => {
  const group = (id: string, x: number, y: number): GroupItem => ({
    id,
    type: 'collapsed',
    data: { groupId: id, order: null },
    position: { x, y },
    ...SIZES.group,
  });
  const cluster = (id: string, x: number, y: number, width: number, height: number): GroupItem => ({
    ...group(id, x, y),
    type: 'cluster',
    width,
    height,
  });
  const at = (items: CanvasItem[]) =>
    Object.fromEntries(items.map((i) => [i.id, [i.position.x, i.position.y]]));
  const overlap = (a: CanvasItem, b: CanvasItem) =>
    a.position.x < b.position.x + b.width! &&
    b.position.x < a.position.x + a.width! &&
    a.position.y < b.position.y + b.height! &&
    b.position.y < a.position.y + a.height!;

  // A row a, b, c, with d below a, f clear of a's expansion and e far below.
  const before = [
    group('a', 0, 0),
    group('b', 320, 0),
    group('c', 640, 40),
    group('d', 0, 200),
    group('e', 900, 600),
    group('f', 700, 300),
  ];

  it('keeps the toggled group in place and pushes neighbours only as far as needed', () => {
    // dagre's new layout moves everything; only the cluster's size counts.
    const next = [
      cluster('a', 50, 50, 600, 400),
      group('b', 700, 0),
      group('c', 1000, 0),
      group('d', 0, 500),
      group('e', 0, 0),
      group('f', 0, 0),
    ];
    const { items: after, pushes } = stableLayout(before, next, new Map());
    // Each clears the box in front of it by 40px; f and e already had room.
    expect(at(after)).toEqual({
      a: [0, 0],
      b: [640, 0],
      c: [920, 40],
      d: [0, 440],
      e: [900, 600],
      f: [700, 300],
    });
    for (const x of after) for (const y of after) if (x !== y) expect(overlap(x, y)).toBe(false);

    // Collapsing closes the gap again.
    expect(
      at(
        stableLayout(
          after,
          next.map((i) => (i.id === 'a' ? group('a', 9, 9) : i)),
          pushes,
        ).items,
      ),
    ).toEqual(at(before));
  });

  it('moves a group pushed right back when the cluster collapses', () => {
    // b sits right of a but below a's collapsed height, so only the expansion reaches it.
    const start = [group('a', 0, 0), group('b', 300, 150)];
    const grown = stableLayout(start, [cluster('a', 0, 0, 600, 400), group('b', 0, 0)], new Map());
    expect(at(grown.items).b).toEqual([640, 150]);
    const shrunk = stableLayout(grown.items, [group('a', 0, 0), group('b', 0, 0)], grown.pushes);
    expect(at(shrunk.items)).toEqual(at(start));
  });

  it('keeps the canvas in place across toggles of the signature review', () => {
    const model = buildModel(data);
    const first = data.plan.groupOrder[0]!;
    let shown = canvasGraph(model, new Set()).items;
    // The reviewer drags the last group somewhere.
    const last = groupItemId(data.plan.groupOrder.at(-1)!);
    shown = shown.map((i) => (i.id === last ? { ...i, position: { x: -500, y: -500 } } : i));
    const start = at(shown);

    const { items: expanded, pushes } = stableLayout(
      shown,
      canvasGraph(model, new Set([first])).items,
      new Map(),
    );
    expect(at(expanded)[groupItemId(first)]).toEqual(start[groupItemId(first)]);
    expect(at(expanded)[last]).toEqual([-500, -500]);
    const top = expanded.filter((i) => i.parentId === undefined);
    for (const x of top) for (const y of top) if (x !== y) expect(overlap(x, y)).toBe(false);

    const collapsed = stableLayout(expanded, canvasGraph(model, new Set()).items, pushes).items;
    expect(at(collapsed)).toEqual(start);
  });
});
