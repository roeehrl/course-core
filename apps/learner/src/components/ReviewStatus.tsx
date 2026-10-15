import React, { useEffect, useState } from "react";

export interface WrittenReview {
  attemptId: string;
  episodeId: string;
  submittedAt: string;
  status: "pending_review" | "met" | "not_met" | "needs_clarification";
  learnerNote: string | null;
  /** Set when this answer replies to a clarification request. */
  continuesAttemptId?: string | null;
  /** Given as a placement question (possibly for an episode that is still locked). */
  placement?: boolean;
  /** The reviewer asked for clarification and the learner has not replied yet. */
  canReply?: boolean;
  /** A judged answer can be appealed once for a second opinion. */
  canAppeal?: boolean;
  appeal?: { state: "open" | "upheld" | "changed"; note: string | null } | null;
  criteria: { id: string; description: string; required: boolean; met: boolean | null; quote: string | null; note: string | null }[];
}
export type ReviewsLoader = (enrollmentId: string, signal: AbortSignal) => Promise<WrittenReview[]>;
export type ReviewReply = (attemptId: string, answer: string) => Promise<void>;
export type ReviewAppeal = (attemptId: string, reason: string) => Promise<void>;
const labels: Record<WrittenReview["status"], string> = {
  pending_review: "Waiting for a reviewer",
  met: "Reviewed · criteria met",
  not_met: "Reviewed · not yet",
  needs_clarification: "Reviewer asked for clarification",
};
/** Shows written answers and their review outcome: one episode's, or (with
 * `placementOnly`) those given as placement questions, whose episodes may still
 * be locked. Pending answers never unlock progress; the gate updates only after review. */
export function ReviewStatus({ loader, enrollmentId, episodeId, placementOnly, revision, onReply, onAppeal }: { loader: ReviewsLoader; enrollmentId: string; episodeId?: string; placementOnly?: boolean; revision: number; onReply?: ReviewReply; onAppeal?: ReviewAppeal }) {
  const [items, setItems] = useState<WrittenReview[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loader(enrollmentId, controller.signal)
      .then((all) => !controller.signal.aborted && setItems(all.filter((r) => (episodeId === undefined || r.episodeId === episodeId) && (!placementOnly || r.placement))))
      .catch(() => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [loader, enrollmentId, episodeId, placementOnly, revision]);
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
            {item.appeal && (
              <p>
                {item.appeal.state === "open"
                  ? "Second opinion requested: another reviewer will look at this answer."
                  : item.appeal.state === "changed"
                    ? "Second opinion changed the decision."
                    : "Second opinion kept the decision."}
                {item.appeal.note && <> Reviewer: {item.appeal.note}</>}
              </p>
            )}
            {item.canAppeal && onAppeal && <AppealBox attemptId={item.attemptId} onAppeal={onAppeal} />}
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

/** Ask once for a different reviewer to look at a judged answer. */
function AppealBox({ attemptId, onAppeal }: { attemptId: string; onAppeal: ReviewAppeal }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = "appeal-" + attemptId;
  if (!open)
    return (
      <button type="button" className="connected-link-button" onClick={() => setOpen(true)}>
        Ask for a second opinion
      </button>
    );
  return (
    <form
      className="connected-reply"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onAppeal(attemptId, reason.trim());
        } catch {
          setError("Your request could not be sent. Explain in at least a few words and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id}>Why should another reviewer look again?</label>
      <textarea id={id} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" disabled={busy || reason.trim().length < 10}>Request a second opinion</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
