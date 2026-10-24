// Bringing the shared selection into view in the guided and file views, which are long scrolling
// pages rather than a canvas.
import { type RefObject, useEffect } from 'react';
import { type Selection, useSelection } from './state.tsx';

/**
 * Scrolls the first element in `pane` that `target(selection)` selects into view, whenever the
 * selection changes or the view is shown again. `target` returns null for selections the view has
 * no place for.
 */
export function useScrollToSelection(
  pane: RefObject<HTMLElement | null>,
  target: (selection: NonNullable<Selection>) => string | null,
) {
  const { selection } = useSelection();
  const selector = selection === null ? null : target(selection);
  useEffect(() => {
    if (selector === null) return;
    // jsdom has no scrollIntoView.
    pane.current?.querySelector(selector)?.scrollIntoView?.({ block: 'nearest' });
  }, [pane, selector]);
}
