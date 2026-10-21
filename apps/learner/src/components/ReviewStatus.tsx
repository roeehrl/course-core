import React, { useEffect, useState } from "react";
import { isAbortError } from "../client/apiClient";
import { useT, type MessageKey } from "../i18n";

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
  /** Staff regraded the answer: a second person's decision replaced the one before it. */
  regrade?: { outcome: "changed" | "upheld"; at: string } | null;
  /** A person confirmed the decision, or the course's fixed check of quotes from the learner's own words did. */
  confirmedBy?: "reviewer" | "automatic_check" | null;
  criteria: { id: string; description: string; required: boolean; met: boolean | null; quote: string | null; note: string | null }[];
}
export type ReviewsLoader = (enrollmentId: string, signal: AbortSignal) => Promise<WrittenReview[]>;
export type ReviewReply = (attemptId: string, answer: string) => Promise<void>;
export type ReviewAppeal = (attemptId: string, reason: string) => Promise<void>;
/** Shows written answers and their review outcome: one episode's, or (with
 * `placementOnly`) those given as placement questions, whose episodes may still
 * be locked. Pending answers never unlock progress; the gate updates only after review. */
export function ReviewStatus({ loader, enrollmentId, episodeId, placementOnly, openOnly, title: titleProp, className, revision, onReply, onAppeal }: {
  loader: ReviewsLoader; enrollmentId: string; episodeId?: string; placementOnly?: boolean;
  /** Only open conversations: a request awaiting the learner's reply, or a reply awaiting review. */
  openOnly?: boolean; title?: string; className?: string; revision: number; onReply?: ReviewReply; onAppeal?: ReviewAppeal;
}) {
  const t = useT();
  const title = titleProp ?? t("reviewStatus.title");
  const [items, setItems] = useState<WrittenReview[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const open = (r: WrittenReview) => Boolean(r.canReply) || (Boolean(r.continuesAttemptId) && r.status === "pending_review");
    loader(enrollmentId, controller.signal)
      .then((all) => !controller.signal.aborted && setItems(all.filter((r) => (episodeId === undefined || r.episodeId === episodeId) && (!placementOnly || r.placement) && (!openOnly || open(r)))))
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setItems([]));
    return () => controller.abort();
  }, [loader, enrollmentId, episodeId, placementOnly, openOnly, revision]);
  if (!items.length) return null;
  return (
    <section className={className ? `connected-reviews ${className}` : "connected-reviews"} aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.attemptId}>
            <strong>
              {(() => {
                const status = t(
                  item.status === "met" && item.confirmedBy === "automatic_check"
                    ? "reviewStatus.status.automaticMet"
                    : (`reviewStatus.status.${item.status}` as MessageKey),
                );
                return item.continuesAttemptId ? t("reviewStatus.replyStatus", { status }) : status;
              })()}
            </strong>
            {item.status === "met" && item.confirmedBy === "automatic_check" && (
              <p className="connected-muted">{t("reviewStatus.automaticCheck")}</p>
            )}
            {item.learnerNote && <p>{t("reviewStatus.reviewerNote", { note: item.learnerNote })}</p>}
            {item.canReply && onReply && <ReplyBox attemptId={item.attemptId} onReply={onReply} />}
            {item.appeal && (
              <p>
                {t(
                  item.appeal.state === "open"
                    ? "reviewStatus.appeal.open"
                    : item.appeal.state === "changed"
                      ? "reviewStatus.appeal.changed"
                      : "reviewStatus.appeal.upheld",
                )}
                {item.appeal.note && <> {t("reviewStatus.reviewerNote", { note: item.appeal.note })}</>}
              </p>
            )}
            {item.regrade && (
              <p>{t(item.regrade.outcome === "changed" ? "reviewStatus.regrade.changed" : "reviewStatus.regrade.upheld")}</p>
            )}
            {item.canAppeal && onAppeal && <AppealBox attemptId={item.attemptId} onAppeal={onAppeal} />}
            {/* A clarification request shows only the reviewer's note and the reply box. */}
            {(item.status === "met" || item.status === "not_met") && (
              <ul>
                {item.criteria.map((c) => (
                  <li key={c.id}>
                    {c.met ? "✓" : "○"}{" "}
                    <bdi>{c.description}</bdi>
                    {c.quote && <span> — <q dir="auto">{c.quote}</q></span>}
                    {c.note && <span className="connected-muted"> — <bdi>{c.note}</bdi></span>}
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
  const t = useT();
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
          setError(t("reviewStatus.reply.error"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id}>{t("reviewStatus.reply.label")}</label>
      <textarea id={id} dir="auto" rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={busy || text.trim().length < 20}>{t("reviewStatus.reply.submit")}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** Ask once for a different reviewer to look at a judged answer. */
function AppealBox({ attemptId, onAppeal }: { attemptId: string; onAppeal: ReviewAppeal }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = "appeal-" + attemptId;
  if (!open)
    return (
      <button type="button" className="connected-link-button" onClick={() => setOpen(true)}>
        {t("reviewStatus.appeal.ask")}
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
          setError(t("reviewStatus.appeal.error"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={id}>{t("reviewStatus.appeal.label")}</label>
      <textarea id={id} dir="auto" rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" disabled={busy || reason.trim().length < 10}>{t("reviewStatus.appeal.submit")}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
