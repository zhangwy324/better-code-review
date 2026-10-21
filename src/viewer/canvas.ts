// The graph canvas's model (spec D1, D6, D12; design reference §6.4): which groups and nodes show
// for the groups expanded, the edges between them, and where they go. Canvas.tsx draws it with
// React Flow. A collapsed group stands for every node in it, so the edges of those nodes are drawn
// to the group and aggregated, e.g. `called by ×3`. Edges inside a collapsed group are hidden until
// it is expanded. Only changed entities are nodes: unchanged callers are not analysed (D12).
// The package's ES module has only a default export, whatever its types say.
import dagre, { type GraphLabel } from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';
import type { ReviewGroup } from '../schemas/plan.ts';
import { groupNodeIds, type Link, linkLabel, type ReviewModel } from './model.ts';

export type GroupItem = Node<{ groupId: string; order: number | null }, 'collapsed' | 'cluster'>;
export type ChangeItem = Node<{ nodeId: string }, 'change'>;
export type CanvasItem = GroupItem | ChangeItem;
export type CanvasEdge = Edge<{ linkIds: string[]; style: Link['style']; label: string }, 'link'>;

/** Collapsed groups and change nodes have fixed sizes, set in styles.css too. */
export const SIZES = { group: { width: 240, height: 76 }, change: { width: 220, height: 68 } };

type Box = { x: number; y: number; width: number; height: number };

export const groupItemId = (id: string) => `group:${id}`;
export const changeItemId = (id: string) => `node:${id}`;

/**
 * The canvas for the groups in `expanded`, laid out left to right in layers with dagre: each
 * group's members inside it, and every edge from a changed entity towards its changed callers.
 */
export function canvasGraph(
  model: ReviewModel,
  expanded: ReadonlySet<string>,
): { items: CanvasItem[]; edges: CanvasEdge[] } {
  const g = new dagre.graphlib.Graph<GraphLabel, Partial<Box>, object>({
    compound: true,
    multigraph: true,
  });
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  // Parents before children, as React Flow needs them.
  const items: CanvasItem[] = [];
  /** Each graph node's item: itself, or the collapsed group that stands for it. */
  const shownAs = new Map<string, string>();
  const add = (
    item: CanvasItem,
    parentId: string | null,
    size?: { width: number; height: number },
  ) => {
    items.push(parentId === null ? item : { ...item, parentId, extent: 'parent' });
    // A copy: dagre writes the position into the label.
    g.setNode(item.id, { ...size });
    if (parentId !== null) g.setParent(item.id, parentId);
  };
  const visit = (group: ReviewGroup, parentId: string | null, order: number | null) => {
    const id = groupItemId(group.id);
    const open = expanded.has(group.id) && group.nodeIds.length + group.childGroupIds.length > 0;
    const data = { groupId: group.id, order };
    if (!open) {
      add(
        { id, type: 'collapsed', data, position: { x: 0, y: 0 }, ...SIZES.group },
        parentId,
        SIZES.group,
      );
      for (const nodeId of groupNodeIds(model, group)) shownAs.set(nodeId, id);
      return;
    }
    add({ id, type: 'cluster', data, position: { x: 0, y: 0 } }, parentId);
    for (const nodeId of group.nodeIds) {
      const item: ChangeItem = {
        id: changeItemId(nodeId),
        type: 'change',
        data: { nodeId },
        position: { x: 0, y: 0 },
        ...SIZES.change,
      };
      add(item, id, SIZES.change);
      shownAs.set(nodeId, item.id);
    }
    for (const childId of group.childGroupIds) {
      const child = model.groups.get(childId);
      if (child !== undefined) visit(child, id, null);
    }
  };
  model.plan.groupOrder.forEach((id, i) => {
    const group = model.groups.get(id);
    if (group !== undefined) visit(group, null, i + 1);
  });

  const edges = new Map<string, CanvasEdge>();
  for (const link of model.links.values()) {
    const source = shownAs.get(link.source);
    const target = shownAs.get(link.target);
    if (source === undefined || target === undefined || source === target) continue;
    const label = linkLabel(link);
    const id = `${source}>${target}>${link.style}>${label}`;
    const edge = edges.get(id);
    if (edge === undefined) {
      edges.set(id, {
        id,
        source,
        target,
        type: 'link',
        className: `link-${link.style}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: `var(--edge-${link.style})` },
        data: { linkIds: [link.id], style: link.style, label },
      });
      g.setEdge(source, target, {}, id);
    } else {
      edge.data!.linkIds.push(link.id);
    }
  }
  for (const edge of edges.values()) {
    const n = edge.data!.linkIds.length;
    if (n > 1) edge.data!.label += ` ×${n}`;
  }

  dagre.layout(g);
  // dagre gives centres, and clusters their bounds; React Flow wants top-left corners, relative to
  // the parent.
  const box = (id: string) => {
    const { x = 0, y = 0, width = 0, height = 0 } = g.node(id);
    return { x: x - width / 2, y: y - height / 2, width, height };
  };
  const laidOut = items.map((item) => {
    const own = box(item.id);
    const parent = item.parentId === undefined ? { x: 0, y: 0 } : box(item.parentId);
    const position = { x: own.x - parent.x, y: own.y - parent.y };
    return item.type === 'cluster'
      ? { ...item, position, width: own.width, height: own.height }
      : { ...item, position };
  });
  return { items: laidOut, edges: [...edges.values()] };
}
