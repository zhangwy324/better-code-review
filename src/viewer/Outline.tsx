// The review outline (§6.2): the plan's groups in reading order, one level of nesting (spec D2),
// each with its home nodes and the nodes it only references.
import type { ReviewGroup } from '../schemas/plan.ts';
import { groupHunkIds } from './model.ts';
import { useIsSelected, useModel, useSelection } from './state.tsx';
import { count } from '../text/index.ts';

export function Outline() {
  const { plan, groups } = useModel();
  return (
    <nav className="pane outline" aria-label="Review outline">
      <h2>Review outline</h2>
      {plan.summary !== '' && <p className="summary">{plan.summary}</p>}
      {plan.fallbackReason !== null && <p className="note">{plan.fallbackReason}</p>}
      <ol className="groups">
        {plan.groupOrder.flatMap((id) => {
          const group = groups.get(id);
          return group === undefined ? [] : [<GroupItem key={id} group={group} />];
        })}
      </ol>
    </nav>
  );
}

function GroupItem({ group }: { group: ReviewGroup }) {
  const model = useModel();
  const { select } = useSelection();
  const selected = useIsSelected('group', group.id);
  return (
    <li>
      <button
        type="button"
        className="item group-title"
        aria-current={selected || undefined}
        onClick={() => select({ kind: 'group', id: group.id })}
      >
        <span>{group.title}</span>
        <span className="count">{count(groupHunkIds(model, group).length, 'hunk')}</span>
      </button>
      <ul className="nodes">
        {group.nodeIds.map((id) => (
          <NodeItem key={id} id={id} />
        ))}
        {group.referenceNodeIds.map((id) => (
          <NodeItem key={`ref-${id}`} id={id} reference />
        ))}
      </ul>
      {group.childGroupIds.length > 0 && (
        <ol className="groups">
          {group.childGroupIds.flatMap((id) => {
            const child = model.groups.get(id);
            return child === undefined ? [] : [<GroupItem key={id} group={child} />];
          })}
        </ol>
      )}
    </li>
  );
}

function NodeItem({ id, reference = false }: { id: string; reference?: boolean }) {
  const node = useModel().nodes.get(id);
  const { select } = useSelection();
  const selected = useIsSelected('node', id);
  if (node === undefined) return null;
  return (
    <li>
      <button
        type="button"
        className={reference ? 'item reference' : 'item'}
        aria-current={selected || undefined}
        title={reference ? `Reviewed in another group: ${node.path}` : node.path}
        onClick={() => select({ kind: 'node', id })}
      >
        {reference && <span aria-label="reference">↗ </span>}
        {node.displayName}
      </button>
    </li>
  );
}
