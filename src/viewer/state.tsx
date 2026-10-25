// State shared by every view (spec D3): the loaded review, what is selected, and the reviewer's
// comments and review progress. The outline, canvas and detail pane read and change the same
// selection, and any view that shows a diff shows and adds to the same comments and marks the same
// hunks (and hunk-less file changes) reviewed, so all of it survives switching views.
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import type { ReviewComment, ReviewFeedback } from '../schemas/feedback.ts';
import {
  feedbackDocument,
  type LineDraft,
  lineComment,
  loadStored,
  nextCommentId,
  reviewedItems,
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

/**
 * The reviewer's comments (feedback.ts), in the order they were written, and the review items they
 * marked reviewed. Progress is kept per item only (spec D5): per hunk, and per file change with no
 * hunks (#127). A node, group or file is reviewed when all its items are (model.ts `progress()`),
 * so no two views can disagree about it.
 */
export interface FeedbackState {
  comments: ReviewComment[];
  /** Review items: hunk IDs, and `fileItemId()`s of hunk-less file changes (model.ts). */
  reviewed: ReadonlySet<string>;
  /** Whether the comments or progress changed since they were last exported or copied. */
  unsaved: boolean;
  addLine: (draft: LineDraft, body: string) => void;
  addGroup: (groupId: string, body: string) => void;
  edit: (id: string, body: string) => void;
  remove: (id: string) => void;
  /** Marks every review item in `itemIds` reviewed, or not reviewed. */
  markReviewed: (itemIds: readonly string[], reviewed: boolean) => void;
  /** The feedback to export or copy. Taking it marks the comments and progress saved. */
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
    return {
      comments: stored?.feedback.comments ?? [],
      reviewed: stored === null ? new Set<string>() : reviewedItems(stored.feedback),
      unsaved: stored?.unsaved ?? false,
    };
  });
  const { comments, reviewed, unsaved } = state;

  useEffect(() => {
    saveStored({ feedback: feedbackDocument(model, comments, reviewed), unsaved });
  }, [model, comments, reviewed, unsaved]);
  // The browser asks before closing a page whose feedback was not exported or copied.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const value = useMemo((): FeedbackState => {
    const change = (f: (comments: ReviewComment[]) => ReviewComment[]) =>
      setState((s) => ({ ...s, comments: f(s.comments), unsaved: true }));
    return {
      comments,
      reviewed,
      unsaved,
      addLine: (draft, body) =>
        change((all) => [...all, lineComment(model, draft, nextCommentId(all), body)]),
      addGroup: (groupId, body) =>
        change((all) => [...all, { id: nextCommentId(all), kind: 'group', groupId, body }]),
      edit: (id, body) => change((all) => all.map((c) => (c.id === id ? { ...c, body } : c))),
      remove: (id) => change((all) => all.filter((c) => c.id !== id)),
      markReviewed: (itemIds, done) =>
        setState((s) => {
          const next = new Set(s.reviewed);
          for (const id of itemIds) {
            if (done) next.add(id);
            else next.delete(id);
          }
          return { ...s, reviewed: next, unsaved: true };
        }),
      take: () => {
        setState((s) => ({ ...s, unsaved: false }));
        return feedbackDocument(model, comments, reviewed);
      },
    };
  }, [model, comments, reviewed, unsaved]);
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
