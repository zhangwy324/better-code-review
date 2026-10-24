// Review progress (#32, spec D5): the reviewer marks hunks reviewed, one at a time in a diff, or
// all of a node's or group's home hunks at once. The marks live in ReviewProvider (state.tsx) and
// everything else is derived from them (model.ts `progress()`), so the graph, guided and file
// views, the outline and the header always agree.
import { type Progress, isReviewed, progress } from './model.ts';
import { useFeedback } from './state.tsx';

const NONE: ReadonlySet<string> = new Set();

/** The progress of `hunkIds`; none are reviewed outside ReviewProvider. */
export function useProgress(hunkIds: readonly string[]): Progress {
  return progress(hunkIds, useFeedback()?.reviewed ?? NONE);
}

/** `2/4 reviewed`, or `✓ 4/4 reviewed` once all are. */
export function progressLabel(p: Progress): string {
  return `${isReviewed(p) ? '✓ ' : ''}${p.reviewed}/${p.total} reviewed`;
}

/**
 * A checkbox that marks all of `hunkIds` reviewed, or none once all are: checked when every one
 * is reviewed, and mixed when some are. Nothing shows outside ReviewProvider or without hunks.
 */
export function ReviewedCheckbox({
  hunkIds,
  label,
  text = 'Reviewed',
}: {
  hunkIds: readonly string[];
  /** The accessible name, e.g. `Mark formatPrice reviewed`. */
  label: string;
  /** The visible text beside the box. */
  text?: string;
}) {
  const feedback = useFeedback();
  const p = useProgress(hunkIds);
  if (feedback === null || p.total === 0) return null;
  const done = isReviewed(p);
  return (
    <label className="reviewed-toggle" title={`${p.reviewed} of ${p.total} hunks reviewed`}>
      <input
        type="checkbox"
        aria-label={label}
        checked={done}
        ref={(input) => {
          if (input !== null) input.indeterminate = !done && p.reviewed > 0;
        }}
        onChange={() => feedback.markReviewed(hunkIds, !done)}
      />
      {text}
    </label>
  );
}
