// Comments (#33, spec D4): the form that writes one, a comment with its edit and delete buttons,
// a group's comments, and the header's export and "Copy feedback for agent". Line comments are
// written in the diff (Diff.tsx). Comment bodies are the reviewer's text, rendered as React text.
import { useState } from 'react';
import type { ReviewComment } from '../schemas/feedback.ts';
import { count } from '../text/index.ts';
import { agentText, FEEDBACK_FILE, feedbackJson } from './feedback.ts';
import { useFeedback, useModel } from './state.tsx';

/** A comment being written or edited. Saving needs some text; it is saved trimmed. */
export function CommentForm({
  label,
  initial = '',
  onSave,
  onCancel,
}: {
  label: string;
  initial?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  return (
    <form
      className="comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim() !== '') onSave(body.trim());
      }}
    >
      <textarea
        aria-label={label}
        value={body}
        autoFocus
        rows={3}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="comment-actions">
        <button type="submit" disabled={body.trim() === ''}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CommentView({ comment }: { comment: ReviewComment }) {
  const feedback = useFeedback();
  const [editing, setEditing] = useState(false);
  if (feedback === null) return null;
  if (editing) {
    return (
      <CommentForm
        label="Edit comment"
        initial={comment.body}
        onSave={(body) => {
          feedback.edit(comment.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="comment">
      <p className="comment-body">{comment.body}</p>
      <div className="comment-actions">
        <button type="button" className="link" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button type="button" className="link" onClick={() => feedback.remove(comment.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** A group's comments, and a form for another (spec D4: group comments, fallback groups too). */
export function GroupComments({ groupId }: { groupId: string }) {
  const feedback = useFeedback();
  const [writing, setWriting] = useState(false);
  if (feedback === null) return null;
  const comments = feedback.comments.filter((c) => c.kind === 'group' && c.groupId === groupId);
  return (
    <section className="group-comments" aria-label="Group comments">
      {comments.map((c) => (
        <CommentView key={c.id} comment={c} />
      ))}
      {writing ? (
        <CommentForm
          label="Comment on this group"
          onSave={(body) => {
            feedback.addGroup(groupId, body);
            setWriting(false);
          }}
          onCancel={() => setWriting(false)}
        />
      ) : (
        <button type="button" className="link" onClick={() => setWriting(true)}>
          Comment on this group
        </button>
      )}
    </section>
  );
}

/**
 * The header's feedback controls: the comment count, the export and the copy. Until the comments
 * and review progress are exported or copied, they say so: the browser may not keep them (spec D5).
 */
export function FeedbackControls() {
  const model = useModel();
  const feedback = useFeedback();
  const [copied, setCopied] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  if (feedback === null) return null;
  const none = feedback.comments.length === 0 && feedback.reviewed.size === 0;

  const exportFile = () => {
    const url = URL.createObjectURL(
      new Blob([feedbackJson(feedback.take())], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = FEEDBACK_FILE;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Downloaded ${FEEDBACK_FILE}`);
  };
  const copy = () => {
    const text = agentText(model, feedback.take());
    // A page opened from file:// may have no clipboard: then the text shows to copy by hand.
    const shown = () => setCopied(text);
    if (navigator.clipboard === undefined) return shown();
    navigator.clipboard.writeText(text).then(() => setStatus('Copied feedback for agent'), shown);
  };

  return (
    <div className="feedback-controls">
      <span>{count(feedback.comments.length, 'comment')}</span>
      {feedback.unsaved && (
        <span
          className="unsaved"
          title="This browser may not keep comments or review progress for a page opened from a file. Export or copy them to keep them."
        >
          not exported
        </span>
      )}
      <button type="button" disabled={none} onClick={exportFile}>
        Export {FEEDBACK_FILE}
      </button>
      <button type="button" disabled={none} onClick={copy}>
        Copy feedback for agent
      </button>
      <span role="status">{status}</span>
      {copied !== null && (
        <div className="copy-fallback" role="dialog" aria-label="Feedback for agent">
          <p>The clipboard isn’t available. Copy this text:</p>
          <textarea readOnly value={copied} rows={12} onFocus={(e) => e.target.select()} />
          <button type="button" onClick={() => setCopied(null)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
