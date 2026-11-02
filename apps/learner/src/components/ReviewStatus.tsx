import React, { useEffect, useState } from "react";
import { isAbortError } from "../client/apiClient";
import { Icon } from "./icons/Icon";
import type { IconName } from "./icons/icons";
import { LongAnswerComposer } from "../connected/ui/LongAnswerComposer";
import { StatusLine } from "../connected/ui/StatusLine";
import { Tag } from "../connected/ui/Tag";
import { useI18n, useT, type MessageKey } from "../i18n";

const STATUS_ICONS: Record<WrittenReview["status"], IconName> = {
  pending_review: "clock",
  met: "check",
  not_met: "rotate-ccw",
  needs_clarification: "quote",
};

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
  const i18n = useI18n(),
    t = i18n.t;
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
  // A person's note, even one that grew from an AI draft only staff saw: no AI badge (§4.14).
  const reviewerNote = (note: string) =>
    i18n.rich("reviewStatus.reviewerNote", { note }, { strong: (children, key) => <strong key={key}>{children as React.ReactNode}</strong> }) as React.ReactNode;
  const chip = (item: WrittenReview) => {
    const automatic = item.status === "met" && item.confirmedBy === "automatic_check";
    const key: MessageKey = automatic ? "reviewStatus.status.automaticMet" : (`reviewStatus.status.${item.status}` as MessageKey);
    return <Tag className="cc-prof-chip" icon={automatic ? "shield-check" : STATUS_ICONS[item.status]} label={t(key)} />;
  };
  return (
    <section className={className ? `connected-reviews ${className}` : "connected-reviews"} aria-label={title}>
      <h3>{title}</h3>
      <ul className="cc-prof-reviews">
        {items.map((item) => (
          <li key={item.attemptId}>
            <p className="cc-prof-review-status">
              {item.continuesAttemptId && <span className="cc-prof-detail">{t("reviewStatus.replyStatus")}</span>}
              {chip(item)}
            </p>
            {item.status === "met" && item.confirmedBy === "automatic_check" && (
              <p className="cc-prof-detail">{t("reviewStatus.automaticCheck")}</p>
            )}
            {item.learnerNote && (
              <p className="cc-prof-note">
                {reviewerNote(item.learnerNote)}
              </p>
            )}
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
                {item.appeal.note && (
                  <>
                    {" "}
                    {reviewerNote(item.appeal.note)}
                  </>
                )}
              </p>
            )}
            {item.regrade && (
              <p>{t(item.regrade.outcome === "changed" ? "reviewStatus.regrade.changed" : "reviewStatus.regrade.upheld")}</p>
            )}
            {item.canAppeal && onAppeal && <AppealBox attemptId={item.attemptId} onAppeal={onAppeal} />}
            {/* A clarification request shows only the reviewer's note and the reply box. */}
            {(item.status === "met" || item.status === "not_met") && (
              <ul className="cc-prof-criteria" aria-label={t("reviewStatus.criteria")}>
                {item.criteria.map((c) => (
                  <li key={c.id}>
                    <Icon name={c.met ? "check" : "x"} size={16} />
                    <span className="cc-ui-sr-only">{t(c.met ? "reviewStatus.criterion.met" : "reviewStatus.criterion.notMet")}</span>
                    <span>
                      <bdi>{c.description}</bdi>
                      {c.quote && <span> — <q dir="auto">{c.quote}</q></span>}
                      {c.note && <span className="connected-muted"> — <bdi>{c.note}</bdi></span>}
                    </span>
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

/** Answer the reviewer's question in your own words, in the long-answer composer (Enter adds a
 * line, Cmd/Ctrl+Enter sends). The reply is reviewed with your earlier answer; it is not graded
 * automatically. */
function ReplyBox({ attemptId, onReply }: { attemptId: string; onReply: ReviewReply }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send() {
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
  }
  return (
    <div className="connected-reply">
      <LongAnswerComposer
        id={"reply-" + attemptId}
        className="cc-prof-composer"
        label={t("reviewStatus.reply.label")}
        placeholder={t("reviewStatus.reply.placeholder")}
        value={text}
        onChange={(value) => setText(value.slice(0, 8000))}
        busy={busy}
        submitLabel={t("reviewStatus.reply.submit")}
        onSubmit={() => void send()}
      />
      {error && <div role="alert"><StatusLine tone="error" text={error} /></div>}
    </div>
  );
}

/** Ask once for a different reviewer to look at a judged answer. */
function AppealBox({ attemptId, onAppeal }: { attemptId: string; onAppeal: ReviewAppeal }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!open)
    return (
      <button type="button" className="cc-ui-text-button cc-prof-text-button" onClick={() => setOpen(true)}>
        {t("reviewStatus.appeal.ask")}
      </button>
    );
  async function send() {
    setBusy(true);
    setError("");
    try {
      await onAppeal(attemptId, reason.trim());
    } catch {
      setError(t("reviewStatus.appeal.error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connected-reply">
      <LongAnswerComposer
        id={"appeal-" + attemptId}
        className="cc-prof-composer"
        label={t("reviewStatus.appeal.label")}
        value={reason}
        onChange={(value) => setReason(value.slice(0, 2000))}
        busy={busy}
        submitLabel={t("reviewStatus.appeal.submit")}
        onSubmit={() => void send()}
      />
      {error && <div role="alert"><StatusLine tone="error" text={error} /></div>}
    </div>
  );
}
