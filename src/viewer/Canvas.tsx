// The center pane: the interactive graph (design reference §6.1, §6.4; spec D1, D6, D12). Groups
// start collapsed, in reading order; expanding one lays the canvas out again with its changes
// inside it, keeping the group and the rest of the canvas where they were (#115). Each edge style
// is one layer and provenance (model.ts `Link`). Hovering an edge shows its direction and
// provenance, and clicking it opens its evidence in the detail pane. Selecting a group or change
// in any pane expands its group and moves the canvas to it, so the detail pane's related changes
// navigate along edges. Groups and changes show their review progress (#32), and the Ungrouped /
// requires review group stands out (§13.2). Text is React text only (spec invariant 6).
import {
  Background,
  BaseEdge,
  Controls,
  type EdgeProps,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  type NodeProps,
  type NodeTypes,
  type EdgeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { count, UNCHANGED_CALLERS_NOTE } from '../text/index.ts';
import {
  type CanvasEdge,
  type CanvasItem,
  canvasGraph,
  type ChangeItem,
  changeItemId,
  type GroupItem,
  groupItemId,
  type Pushes,
  stableLayout,
} from './canvas.ts';
import {
  groupHunkIds,
  groupNodeIds,
  isReviewed,
  isUngrouped,
  type Link,
  lineCounts,
  linkSentence,
  STYLE_DESCRIPTIONS,
} from './model.ts';
import { progressLabel, useProgress } from './Progress.tsx';
import { useIsSelected, useModel, useSelection } from './state.tsx';

const LEGEND: Record<Link['style'], string> = {
  verified: 'verified',
  possible: 'possible',
  inferred: 'inferred (agent: yes)',
  rejected: 'rejected (agent: no)',
  relationship: 'agent-inferred link',
};

const ExpandContext = createContext<(groupId: string) => void>(() => {});

const nodeTypes: NodeTypes = { collapsed: GroupNode, cluster: ClusterNode, change: ChangeNode };
const edgeTypes: EdgeTypes = { link: LinkEdge };

export function Canvas() {
  return (
    <section className="pane canvas" aria-label="Canvas">
      <div className="canvas-legend">
        <p className="note">{UNCHANGED_CALLERS_NOTE}</p>
        <ul aria-label="Edge styles">
          {Object.entries(LEGEND).map(([style, label]) => (
            <li
              key={style}
              className={`link-${style}`}
              title={STYLE_DESCRIPTIONS[style as Link['style']]}
            >
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" />
              </svg>
              {label}
            </li>
          ))}
        </ul>
      </div>
      <div className="canvas-flow">
        <ReactFlowProvider>
          <Graph />
        </ReactFlowProvider>
      </div>
    </section>
  );
}

function Graph() {
  const model = useModel();
  const { selection, select } = useSelection();
  const flow = useReactFlow();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** The item to bring into view once the canvas has its new layout. */
  const [focus, setFocus] = useState<{ id: string } | null>(null);
  const focused = useRef(focus);
  const { items, edges } = useMemo(() => canvasGraph(model, expanded), [model, expanded]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasItem>(items);
  const parents = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of model.groups.values()) for (const c of g.childGroupIds) map.set(c, g.id);
    return map;
  }, [model]);

  // Re-layout after expand or collapse, keeping what didn't change where it was, dragged or not.
  // Dragged positions last for the session (not saved, spec).
  const [laidOut, setLaidOut] = useState(items);
  const [pushes, setPushes] = useState<Pushes>(new Map());
  if (laidOut !== items) {
    setLaidOut(items);
    const placed = stableLayout(nodes, items, pushes);
    setNodes(placed.items);
    setPushes(placed.pushes);
  }

  // A selection from any pane shows on the canvas: a group expands, and so do a change's groups.
  const [shown, setShown] = useState(selection);
  if (shown !== selection) {
    setShown(selection);
    if (selection?.kind === 'node' || selection?.kind === 'group') {
      const home = selection.kind === 'node' ? model.homeGroup.get(selection.id)?.id : selection.id;
      const open: string[] = [];
      for (let at = home; at !== undefined; at = parents.get(at)) open.push(at);
      if (!open.every((id) => expanded.has(id))) setExpanded(new Set([...expanded, ...open]));
      const id = selection.kind === 'node' ? changeItemId(selection.id) : groupItemId(selection.id);
      setFocus({ id });
    }
  }

  useEffect(() => {
    if (focus === null || focused.current === focus || !nodes.some((n) => n.id === focus.id)) {
      return;
    }
    focused.current = focus;
    void flow.fitView({ nodes: [{ id: focus.id }], maxZoom: 1, duration: 200 });
  }, [focus, nodes, flow]);

  const toggle = (groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
  };

  return (
    <ExpandContext value={toggle}>
      <ReactFlow<CanvasItem, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgeClick={(_, edge) => select({ kind: 'links', ids: edge.data!.linkIds })}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        minZoom={0.1}
        // review.html links to nothing (spec D7); the attribution is a link.
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ExpandContext>
  );
}

/** A collapsed group: its place in the reading order, title and size. */
function GroupNode({ data }: NodeProps<GroupItem>) {
  const model = useModel();
  const { select } = useSelection();
  const toggle = useContext(ExpandContext);
  const selected = useIsSelected('group', data.groupId);
  const group = model.groups.get(data.groupId)!;
  const changes = groupNodeIds(model, group).length;
  const p = useProgress(groupHunkIds(model, group));
  return (
    <div
      className={isUngrouped(group) ? 'canvas-group ungrouped' : 'canvas-group'}
      aria-current={selected || undefined}
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="canvas-select"
        title={group.title}
        onClick={() => select({ kind: 'group', id: group.id })}
      >
        <strong>
          {data.order !== null && <span className="order">{data.order}</span>}
          {group.title}
        </strong>
        <span className={isReviewed(p) ? 'count done' : 'count'}>
          {count(changes, 'change')} · {p.reviewed}/{count(p.total, 'hunk')} reviewed
        </span>
      </button>
      {changes > 0 && (
        <button
          type="button"
          className="toggle"
          aria-label={`Expand ${group.title}`}
          title="Expand"
          onClick={() => toggle(group.id)}
        >
          +
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** An expanded group: a box around its changes, with its title above. */
function ClusterNode({ data }: NodeProps<GroupItem>) {
  const model = useModel();
  const { select } = useSelection();
  const toggle = useContext(ExpandContext);
  const selected = useIsSelected('group', data.groupId);
  const group = model.groups.get(data.groupId)!;
  const p = useProgress(groupHunkIds(model, group));
  return (
    <div
      className={isUngrouped(group) ? 'canvas-cluster ungrouped' : 'canvas-cluster'}
      aria-current={selected || undefined}
    >
      <div className="cluster-title">
        <button
          type="button"
          className="toggle"
          aria-label={`Collapse ${group.title}`}
          title="Collapse"
          onClick={() => toggle(group.id)}
        >
          −
        </button>
        <button
          type="button"
          className="link"
          onClick={() => select({ kind: 'group', id: group.id })}
        >
          {data.order !== null && <span className="order">{data.order}</span>}
          {group.title}
        </button>
        <span className={isReviewed(p) ? 'count done' : 'count'}>{progressLabel(p)}</span>
      </div>
    </div>
  );
}

/**
 * A change: a compact preview, not its diff (spec D3). Selecting it opens the diff in the detail
 * pane. It says when the analyzer capped its relationships ("Showing N of M", spec D1).
 */
function ChangeNode({ data }: NodeProps<ChangeItem>) {
  const model = useModel();
  const { select } = useSelection();
  const selected = useIsSelected('node', data.nodeId);
  const node = model.nodes.get(data.nodeId)!;
  const { added, removed } = lineCounts(
    node.hunkIds.flatMap((id) => model.hunks.get(id)?.hunk ?? []),
  );
  const caps = model.graph.caps.filter((c) => c.entityId === node.entityId);
  const p = useProgress(node.hunkIds);
  return (
    <div
      className={isReviewed(p) ? 'canvas-change reviewed' : 'canvas-change'}
      aria-current={selected || undefined}
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="canvas-select"
        title={node.path}
        onClick={() => select({ kind: 'node', id: node.id })}
      >
        <strong>{node.displayName}</strong>
        <span className="path">{node.path}</span>
        <span className="count">
          {node.entityKind ?? node.kind} · <span className="plus">+{added}</span>{' '}
          <span className="minus">−{removed}</span>
          {caps.map((c) => ` · showing ${c.shown} of ${c.total} ${c.relation}`)}
          {p.total > 0 && ` · ${progressLabel(p)}`}
        </span>
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** An edge, with its label; hovering shows each link's direction and provenance. */
function LinkEdge(props: EdgeProps<CanvasEdge>) {
  const model = useModel();
  const { select } = useSelection();
  const [path, labelX, labelY] = getBezierPath(props);
  const data = props.data!;
  const title = [
    STYLE_DESCRIPTIONS[data.style],
    ...data.linkIds.map((id) => linkSentence(model, model.links.get(id)!)),
    'Click for the evidence.',
  ].join('\n');
  return (
    <>
      <g>
        <title>{title}</title>
        <BaseEdge path={path} {...(props.markerEnd && { markerEnd: props.markerEnd })} />
      </g>
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-label link-${data.style} nodrag nopan`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={title}
          onClick={() => select({ kind: 'links', ids: data.linkIds })}
        >
          {data.label}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
