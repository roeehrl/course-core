import React, { useEffect, useState } from "react";

export interface WrittenReview {
  attemptId: string;
  episodeId: string;
  submittedAt: string;
  status: "pending_review" | "met" | "not_met" | "needs_clarification";
  learnerNote: string | null;
  /** Set when this answer replies to a clarification request. */
  continuesAttemptId?: string | null;
  /** The reviewer asked for clarification and the learner has not replied yet. */
  canReply?: boolean;
  criteria: { id: string; description: string; required: boolean; met: boolean | null; quote: string | null; note: string | null }[];
}
export type ReviewsLoader = (enrollmentId: string, signal: AbortSignal) => Promise<WrittenReview[]>;
export type ReviewReply = (attemptId: string, answer: string) => Promise<void>;
const labels: Record<WrittenReview["status"], string> = {
  pending_review: "Waiting for a reviewer",
  met: "Reviewed · criteria met",
  not_met: "Reviewed · not yet",
  needs_clarification: "Reviewer asked for clarification",
};
/** Shows this episode's written answers and their review outcome. Pending
 * answers never unlock progress; the gate updates only after review. */
export function ReviewStatus({ loader, enrollmentId, episodeId, revision, onReply }: { loader: ReviewsLoader; enrollmentId: string; episodeId: string; revision: number; onReply?: ReviewReply }) {
  const [items, setItems] = useState<WrittenReview[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loader(enrollmentId, controller.signal)
      .then((all) => !controller.signal.aborted && setItems(all.filter((r) => r.episodeId === episodeId)))
      .catch(() => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [loader, enrollmentId, episodeId, revision]);
  if (!items.length) return null;
  return (
    <section className="connected-reviews" aria-label="Your written answers">
      <h3>Your written answers</h3>
      <ul>
        {items.map((item) => (
          <li key={item.attemptId}>
            <strong>{item.continuesAttemptId ? "Your reply · " : ""}{labels[item.status]}</strong>
            {item.learnerNote && <p>Reviewer: {item.learnerNote}</p>}
            {item.canReply && onReply && <ReplyBox attemptId={item.attemptId} onReply={onReply} />}
            {/* A clarification request shows only the reviewer's note and the reply box. */}
            {(item.status === "met" || item.status === "not_met") && (
              <ul>
                {item.criteria.map((c) => (
                  <li key={c.id}>
                    {c.met ? "✓" : "○"} {c.description}
                    {c.quote && <span> — <q>{c.quote}</q></span>}
                    {c.note && <span className="connected-muted"> — {c.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Answer the reviewer's question in your own words. The reply is reviewed with
 * your earlier answer; it is not graded automatically. */
function ReplyBox({ attemptId, onReply }: { attemptId: string; onReply: ReviewReply }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = "reply-" + attemptId;
  return (
    <form
      className="connected-reply"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onReply(attemptId, text.trim());
          setText("");
        } catch {
          setError("Your reply could not be sent. Write at least a sentence and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id}>Your reply to the reviewer</label>
      <textarea id={id} rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={busy || text.trim().length < 20}>Send reply for review</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
