// Review progress (#32, spec D5): the reviewer marks review items reviewed: hunks, one at a time in
// a diff, and file changes with no hunks (a binary file, a mode change, a pure rename) as a whole
// (#127), or all of a node's or group's home items at once. The marks live in ReviewProvider
// (state.tsx) and everything else is derived from them (model.ts `progress()`), so the graph,
// guided and file views, the outline and the header always agree.
import { type Progress, isReviewed, itemsLabel, progress } from './model.ts';
import { useFeedback } from './state.tsx';

const NONE: ReadonlySet<string> = new Set();

/** The progress of `itemIds`; none are reviewed outside ReviewProvider. */
export function useProgress(itemIds: readonly string[]): Progress {
  return progress(itemIds, useFeedback()?.reviewed ?? NONE);
}

/** `2/4 reviewed`, or `✓ 4/4 reviewed` once all are. */
export function progressLabel(p: Progress): string {
  return `${isReviewed(p) ? '✓ ' : ''}${p.reviewed}/${p.total} reviewed`;
}

/**
 * A checkbox that marks all of `itemIds` reviewed, or none once all are: checked when every one
 * is reviewed, and mixed when some are. Nothing shows outside ReviewProvider or without items.
 */
export function ReviewedCheckbox({
  itemIds,
  label,
  text = 'Reviewed',
}: {
  /** Review items (model.ts `reviewItemIds()`): hunk IDs or hunk-less file changes. */
  itemIds: readonly string[];
  /** The accessible name, e.g. `Mark formatPrice reviewed`. */
  label: string;
  /** The visible text beside the box. */
  text?: string;
}) {
  const feedback = useFeedback();
  const p = useProgress(itemIds);
  if (feedback === null || p.total === 0) return null;
  const done = isReviewed(p);
  return (
    <label className="reviewed-toggle" title={`${p.reviewed} of ${itemsLabel(p)} reviewed`}>
      <input
        type="checkbox"
        aria-label={label}
        checked={done}
        ref={(input) => {
          if (input !== null) input.indeterminate = !done && p.reviewed > 0;
        }}
        onChange={() => feedback.markReviewed(itemIds, !done)}
      />
      {text}
    </label>
  );
}
