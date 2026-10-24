// State shared by every view (spec D3): the loaded review, what is selected, and the reviewer's
// comments. The outline, canvas and detail pane read and change the same selection, and any view
// that shows a diff shows and adds to the same comments, so both survive switching views.
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { ReviewComment, ReviewFeedback } from '../schemas/feedback.ts';
import {
  feedbackDocument,
  type LineDraft,
  lineComment,
  loadStored,
  nextCommentId,
  saveStored,
} from './feedback.ts';
import type { ReviewModel } from './model.ts';

/** A group, node or hunk, or the links one canvas edge stands for (model.ts `links`). */
export type Selection =
  { kind: 'group' | 'node' | 'hunk'; id: string } | { kind: 'links'; ids: string[] } | null;

interface SelectionState {
  selection: Selection;
  select: (selection: Selection) => void;
}

/** The reviewer's comments (feedback.ts), in the order they were written. */
export interface FeedbackState {
  comments: ReviewComment[];
  /** Whether the comments changed since they were last exported or copied. */
  unsaved: boolean;
  addLine: (draft: LineDraft, body: string) => void;
  addGroup: (groupId: string, body: string) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
  /** The feedback to export or copy. Taking it marks the comments saved. */
  take: () => ReviewFeedback;
}

const ModelContext = createContext<ReviewModel | null>(null);
const SelectionContext = createContext<SelectionState | null>(null);
const FeedbackContext = createContext<FeedbackState | null>(null);

export function ReviewProvider({ model, children }: { model: ReviewModel; children: ReactNode }) {
  const [selection, select] = useState<Selection>(null);
  const value = useMemo(() => ({ selection, select }), [selection]);
  return (
    <ModelContext value={model}>
      <SelectionContext value={value}>
        <FeedbackProvider model={model}>{children}</FeedbackProvider>
      </SelectionContext>
    </ModelContext>
  );
}

function FeedbackProvider({ model, children }: { model: ReviewModel; children: ReactNode }) {
  const [state, setState] = useState(() => {
    const stored = loadStored(model.changeSet.snapshotId);
    return { comments: stored?.feedback.comments ?? [], unsaved: stored?.unsaved ?? false };
  });
  const { comments, unsaved } = state;

  useEffect(() => {
    saveStored({ feedback: feedbackDocument(model, comments), unsaved });
  }, [model, comments, unsaved]);
  // The browser asks before closing a page whose comments were not exported or copied.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const value = useMemo((): FeedbackState => {
    const change = (f: (comments: ReviewComment[]) => ReviewComment[]) =>
      setState((s) => ({ comments: f(s.comments), unsaved: true }));
    return {
      comments,
      unsaved,
      addLine: (draft, body) =>
        change((all) => [...all, lineComment(model, draft, nextCommentId(all), body)]),
      addGroup: (groupId, body) =>
        change((all) => [...all, { id: nextCommentId(all), kind: 'group', groupId, body }]),
      edit: (id, body) => change((all) => all.map((c) => (c.id === id ? { ...c, body } : c))),
      remove: (id) => change((all) => all.filter((c) => c.id !== id)),
      take: () => {
        setState((s) => ({ ...s, unsaved: false }));
        return feedbackDocument(model, comments);
      },
    };
  }, [model, comments, unsaved]);
  return <FeedbackContext value={value}>{children}</FeedbackContext>;
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

/**
 * The comments, or null outside ReviewProvider: a diff (Diff.tsx) rendered on its own shows no
 * comments and takes none.
 */
export function useFeedback(): FeedbackState | null {
  return useContext(FeedbackContext);
}

/** Whether `kind`/`id` is selected, for `aria-current` and styling. */
export function useIsSelected(kind: 'group' | 'node' | 'hunk', id: string): boolean {
  const { selection } = useSelection();
  return selection?.kind === kind && selection.id === id;
}
