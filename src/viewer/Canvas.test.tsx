// @vitest-environment jsdom
// #30 acceptance: the root change points to its changed callers; the unchanged caller is absent.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UNCHANGED_CALLERS_NOTE } from '../text/index.ts';
import { canvasGraph, changeItemId, groupItemId } from './canvas.ts';
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
