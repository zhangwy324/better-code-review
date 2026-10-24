// The guided review (design reference §6.1, §5.4; spec D2, D3): a reading surface for the plan.
// Its groups follow the plan's reading order, numbered as on the canvas, with child groups nested
// inside their parent. Each group shows its description and the real diff of every change whose
// home it is; a change homed elsewhere shows as a reference that selects it, not as a copy (D2).
// Selecting in any pane scrolls the view to the group, change or hunk. The plan's summary and
// fallback note are in the outline, which is beside every view, so they aren't repeated here.
// Each group and change can be marked reviewed at once, and each hunk in its diff (#32, spec D5).
import { useRef } from 'react';
import type { ChangeNode } from '../schemas/graph.ts';
import type { ReviewGroup } from '../schemas/plan.ts';
import { count } from '../text/index.ts';
import { Diffs } from './Detail.tsx';
import { groupHunkIds, isUngrouped } from './model.ts';
import { progressLabel, ReviewedCheckbox, useProgress } from './Progress.tsx';
import { useScrollToSelection } from './scroll.ts';
import { useIsSelected, useModel, useSelection } from './state.tsx';

export function Guided() {
  const { plan, groups } = useModel();
  const pane = useRef<HTMLElement>(null);
  useScrollToSelection(pane, (selection) => {
    if (selection.kind === 'group') return `[data-group-id="${selection.id}"]`;
    if (selection.kind === 'node') return `[data-node-id="${selection.id}"]`;
    if (selection.kind === 'hunk') return `[data-hunk-id="${selection.id}"]`;
    return null;
  });
  return (
    <section ref={pane} className="pane guided" aria-label="Guided review">
      <h2>Guided review</h2>
      <ol className="guided-groups">
        {plan.groupOrder.flatMap((id, i) => {
          const group = groups.get(id);
          return group === undefined ? [] : [<GuidedGroup key={id} group={group} order={i + 1} />];
        })}
      </ol>
    </section>
  );
}

function GuidedGroup({ group, order }: { group: ReviewGroup; order: number | null }) {
  const model = useModel();
  const { select } = useSelection();
  const selected = useIsSelected('group', group.id);
  const references = group.referenceNodeIds.flatMap((id) => {
    const node = model.nodes.get(id);
    return node === undefined ? [] : [node];
  });
  const hunkIds = groupHunkIds(model, group);
  const p = useProgress(hunkIds);
  return (
    <li
      className={isUngrouped(group) ? 'guided-group ungrouped' : 'guided-group'}
      data-group-id={group.id}
      aria-current={selected || undefined}
    >
      <h3>
        <button
          type="button"
          className="link"
          onClick={() => select({ kind: 'group', id: group.id })}
        >
          {order !== null && <span className="order">{order}</span>}
          {group.title}
        </button>{' '}
        <span className="count">
          {count(p.total, 'hunk')} · {progressLabel(p)}
        </span>{' '}
        <ReviewedCheckbox
          hunkIds={hunkIds}
          label={`Mark group ${group.title} reviewed`}
          text="Group reviewed"
        />
      </h3>
      {group.description !== '' && <p>{group.description}</p>}
      {group.nodeIds.map((id) => {
        const node = model.nodes.get(id);
        return node === undefined ? null : <GuidedNode key={id} node={node} />;
      })}
      {references.length > 0 && (
        <p className="reference">
          Also see, reviewed in another group:{' '}
          {references.map((node, i) => (
            <span key={node.id}>
              {i > 0 && ', '}
              <button
                type="button"
                className="link"
                title={node.path}
                onClick={() => select({ kind: 'node', id: node.id })}
              >
                ↗ {node.displayName}
              </button>
            </span>
          ))}
        </p>
      )}
      {group.childGroupIds.length > 0 && (
        <ol className="guided-groups">
          {group.childGroupIds.flatMap((id) => {
            const child = model.groups.get(id);
            return child === undefined ? [] : [<GuidedGroup key={id} group={child} order={null} />];
          })}
        </ol>
      )}
    </li>
  );
}

function GuidedNode({ node }: { node: ChangeNode }) {
  const { select } = useSelection();
  const selected = useIsSelected('node', node.id);
  return (
    <article className="guided-node" data-node-id={node.id} aria-current={selected || undefined}>
      <h4>
        <button
          type="button"
          className="link"
          onClick={() => select({ kind: 'node', id: node.id })}
        >
          {node.displayName}
        </button>{' '}
        <span className="path">{node.path}</span>{' '}
        <ReviewedCheckbox hunkIds={node.hunkIds} label={`Mark ${node.displayName} reviewed`} />
      </h4>
      <Diffs hunkIds={node.hunkIds} />
    </article>
  );
}
