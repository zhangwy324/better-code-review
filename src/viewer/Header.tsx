// The header (§6.2): what is reviewed, the snapshot, hunk coverage, review progress (#32) and the
// feedback export (#33). Coverage says how many hunks are mapped, never that all effects were
// found (design reference §13.2, spec invariant 2).
import { FeedbackControls } from './Comments.tsx';
import { targetLabel } from './model.ts';
import { useProgress } from './Progress.tsx';
import { useModel } from './state.tsx';

/** What the coverage badge counts, and what it doesn't claim. */
const COVERAGE_TITLE =
  'Hunks on a change in the graph and the guided review. Every hunk is in the Files view. ' +
  'This counts the changed hunks shown, not the effects of the change: whether every affected ' +
  'caller or behaviour was found is not checked.';

export function Header() {
  const model = useModel();
  const { snapshotId } = model.changeSet;
  const { mapped, total } = model.coverage;
  const { reviewed } = useProgress([...model.hunks.keys()]);
  return (
    <header className="header">
      <span className="brand">Better Code Review</span>
      <span>{targetLabel(model)}</span>
      <span title={snapshotId}>snapshot {snapshotId.slice(0, 12)}</span>
      <span className={mapped < total ? 'coverage unmapped' : 'coverage'} title={COVERAGE_TITLE}>
        {mapped}/{total} hunks mapped
      </span>
      <span className="progress">
        {reviewed}/{total} hunks reviewed
      </span>
      <FeedbackControls />
    </header>
  );
}
