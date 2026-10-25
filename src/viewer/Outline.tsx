// The review outline (§6.2): the plan's groups in reading order, one level of nesting (spec D2),
// each with its review progress (#32), its home nodes and the nodes it only references. The
// Ungrouped / requires review group stands out (§13.2). Above the groups, what analysis the
// review had: the capability tiers of the files and each language server's status, so a missing
// analyzer is never hidden (design reference §10.8, §13.4; spec D11). Below them, a reminder that
// the page holds the code.
import type { ReviewGroup } from '../schemas/plan.ts';
import { count, occurrences } from '../text/index.ts';
import {
  groupItemIds,
  isReviewed,
  itemsLabel,
  nodeItemIds,
  isUngrouped,
  LANGUAGE_STATUS,
  TIER_DESCRIPTIONS,
} from './model.ts';
import { progressLabel, useProgress } from './Progress.tsx';
import { useIsSelected, useModel, useSelection } from './state.tsx';

export function Outline() {
  const { plan, groups } = useModel();
  return (
    <nav className="pane outline" aria-label="Review outline">
      <h2>Review outline</h2>
      {plan.summary !== '' && <p className="summary">{plan.summary}</p>}
      {plan.fallbackReason !== null && <p className="note">{plan.fallbackReason}</p>}
      <Analysis />
      <ol className="groups">
        {plan.groupOrder.flatMap((id) => {
          const group = groups.get(id);
          return group === undefined ? [] : [<GroupItem key={id} group={group} />];
        })}
      </ol>
      <p className="hint">{SHARING_NOTE}</p>
    </nav>
  );
}

/** The page carries the code it reviews (spec D7), so sharing it shares the code (§19.5 Q6, #35). */
export const SHARING_NOTE =
  'This page contains the full text of every changed file. Share it only where that code may go.';

/**
 * The analysis the review had: how many files got each capability tier, and each language's
 * language server status with what to do about a missing one.
 */
function Analysis() {
  const { graph } = useModel();
  if (graph.files.length === 0) return null;
  return (
    <section className="analysis" aria-label="Analysis">
      <p>
        Analysis:{' '}
        {occurrences(graph.files.map((f) => f.capabilityTier)).map(([tier, n], i) => (
          <span key={tier}>
            {i > 0 && ', '}
            <span className={`tier tier-${tier}`} title={TIER_DESCRIPTIONS[tier]}>
              {count(n, `${tier} file`)}
            </span>
          </span>
        ))}
      </p>
      {graph.languages.length > 0 && (
        <ul>
          {graph.languages.map((l) => (
            <li
              key={`${l.language}-${l.side}`}
              className={l.status === 'ok' ? undefined : 'missing'}
            >
              {l.language}
              {l.side === 'old' && ' (old side)'}: {LANGUAGE_STATUS[l.status]}
              {l.server !== null && ` (${l.server.name})`}
              {l.guidance !== null && `. ${l.guidance}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupItem({ group }: { group: ReviewGroup }) {
  const model = useModel();
  const { select } = useSelection();
  const selected = useIsSelected('group', group.id);
  const p = useProgress(groupItemIds(model, group));
  return (
    <li className={isUngrouped(group) ? 'ungrouped' : undefined}>
      <button
        type="button"
        className="item group-title"
        aria-current={selected || undefined}
        onClick={() => select({ kind: 'group', id: group.id })}
      >
        <span>{group.title}</span>
        <span
          className={isReviewed(p) ? 'count done' : 'count'}
          title={`${p.reviewed} of ${itemsLabel(p)} reviewed`}
        >
          {progressLabel(p)}
        </span>
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
  const { select } = useSelection();
  const selected = useIsSelected('node', id);
  const model = useModel();
  const node = model.nodes.get(id);
  const done = isReviewed(useProgress(node === undefined ? [] : nodeItemIds(model, node)));
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
        <span>
          {reference && <span aria-label="reference">↗ </span>}
          {node.displayName}
        </span>
        {done && (
          <span className="count done" aria-label="reviewed">
            ✓
          </span>
        )}
      </button>
    </li>
  );
}
