// State shared by every view (spec D3): the loaded review, and what is selected. The outline,
// canvas and detail pane read and change the same selection, so it survives switching views.
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import type { ReviewModel } from './model.ts';

export type Selection = { kind: 'group' | 'node' | 'hunk'; id: string } | null;

interface SelectionState {
  selection: Selection;
  select: (selection: Selection) => void;
}

const ModelContext = createContext<ReviewModel | null>(null);
const SelectionContext = createContext<SelectionState | null>(null);

export function ReviewProvider({ model, children }: { model: ReviewModel; children: ReactNode }) {
  const [selection, select] = useState<Selection>(null);
  const value = useMemo(() => ({ selection, select }), [selection]);
  return (
    <ModelContext value={model}>
      <SelectionContext value={value}>{children}</SelectionContext>
    </ModelContext>
  );
}

export function useModel(): ReviewModel {
  const model = useContext(ModelContext);
  if (model === null) throw new Error('useModel() outside ReviewProvider');
  return model;
}

export function useSelection(): SelectionState {
  const state = useContext(SelectionContext);
  if (state === null) throw new Error('useSelection() outside ReviewProvider');
  return state;
}

/** Whether `kind`/`id` is selected, for `aria-current` and styling. */
export function useIsSelected(kind: NonNullable<Selection>['kind'], id: string): boolean {
  const { selection } = useSelection();
  return selection?.kind === kind && selection.id === id;
}
