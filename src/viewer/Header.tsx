// The header (§6.2): what is reviewed, the snapshot, hunk coverage and the feedback export (#33).
// Review progress joins it in #32. Coverage says how many hunks are mapped, never that all
// effects were found (spec invariant 2).
import { FeedbackControls } from './Comments.tsx';
import { targetLabel } from './model.ts';
import { useModel } from './state.tsx';

export function Header() {
  const model = useModel();
  const { snapshotId } = model.changeSet;
  const { mapped, total } = model.coverage;
  return (
    <header className="header">
      <span className="brand">Better Code Review</span>
      <span>{targetLabel(model)}</span>
      <span title={snapshotId}>snapshot {snapshotId.slice(0, 12)}</span>
      <span className="coverage">
        {mapped}/{total} hunks mapped
      </span>
      <FeedbackControls />
    </header>
  );
}
