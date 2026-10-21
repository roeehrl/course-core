import React, { useId, useState } from "react";
import type { NextAction } from "@course-core/sdk";
import type { GateView } from "../client/apiClient";
import { englishTranslator, useT, type Translate } from "../i18n";

type GateStatus = NonNullable<GateView["status"]>;
const GATE_STATUSES: readonly GateStatus[] = ["ready", "needs_evidence", "needs_help", "under_review", "closed_with_gaps"];
/** Learner wording for the five server decision statuses. */
export const gateStatusLabel = (status: GateStatus, t: Translate = englishTranslator().t) =>
  t(`gateDecision.status.${status}`);
/** The English status wording, for tests and callers without a translator. */
export const GATE_STATUS_LABELS = Object.fromEntries(
  GATE_STATUSES.map((status) => [status, gateStatusLabel(status)]),
) as Record<GateStatus, string>;

/**
 * The server's readiness decision for this lesson's checkpoint: its status, why, each readiness
 * criterion and the concrete next steps the server allows. It displays what the server decided;
 * pressing a step never grants credit by itself.
 */
const REVIEW_MIN = 10, REVIEW_MAX = 2000;
export function GateDecisionPanel({ gate, pending, onAction, onRequestReview }: {
  gate: GateView; pending: boolean; onAction: (action: NextAction) => void;
  /** Sends a staff review request for the current decision; offered when the decision allows an appeal. */
  onRequestReview?: (reason: string) => Promise<unknown>;
}) {
  const t = useT();
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  if (!gate.status) return null;
  const criteria = gate.criterionResults ?? [];
  const review = gate.review ?? null, exception = gate.exception ?? null;
  // While a request is open or an exception stands, the appeal step is replaced by its status.
  const actions = (gate.nextActions ?? []).filter((action) => action.kind !== "appeal" || (onRequestReview && review?.state !== "open" && !exception));
  const trimmed = reason.trim();
  const choose = (action: NextAction) => (action.kind === "appeal" && onRequestReview ? setReviewing(true) : onAction(action));
  return (
    <section className="connected-gate" data-status={gate.status} aria-labelledby="connected-gate-title" data-testid="gate-decision">
      <div className="connected-gate-head">
        <p className="connected-eyebrow">{t("gateDecision.eyebrow")}</p>
        <h3 id="connected-gate-title" className="connected-gate-status" aria-live="polite">
          <span className="connected-gate-dot" aria-hidden="true" />
          {gateStatusLabel(gate.status, t)}
        </h3>
      </div>
      {gate.learnerVisibleReason && <p className="connected-gate-reason" dir="auto">{gate.learnerVisibleReason}</p>}
      {criteria.length > 0 && (
        <ul className="connected-gate-criteria" aria-label={t("gateDecision.criteria")}>
          {criteria.map((criterion) => {
            const state = criterion.met === true ? "met" : criterion.met === "pending" ? "pending" : "unmet";
            return (
              <li key={criterion.criterionId} data-state={state}>
                <strong>{t(`gateDecision.criterion.${state}`)}</strong>
                <span dir="auto">{criterion.reason}</span>
              </li>
            );
          })}
        </ul>
      )}
      {actions.length > 0 && (
        <div className="connected-gate-actions" role="group" aria-label={t("gateDecision.nextSteps")}>
          {actions.map((action, index) => action.kind === "await_review" ? (
            <p key={`await:${index}`} className="connected-gate-wait" dir="auto">{action.label}</p>
          ) : (
            <button
              key={`${action.kind}:${action.targetId ?? ""}:${index}`}
              type="button"
              className={index === 0 ? "connected-gate-action primary" : "connected-gate-action"}
              data-kind={action.kind}
              disabled={pending}
              aria-expanded={action.kind === "appeal" && onRequestReview ? reviewing : undefined}
              onClick={() => choose(action)}
            >
              <bdi>{action.label}</bdi>
            </button>
          ))}
        </div>
      )}
      {reviewing && onRequestReview && !exception && review?.state !== "open" && (
        <form
          className="connected-gate-review-form"
          aria-label={t("gateDecision.review.form")}
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length < REVIEW_MIN || pending) return;
            void onRequestReview(trimmed).then(() => { setReviewing(false); setReason(""); }, () => undefined);
          }}
        >
          <label htmlFor={reasonId}>{t("gateDecision.review.reasonLabel")}</label>
          <textarea id={reasonId} dir="auto" value={reason} maxLength={REVIEW_MAX} rows={3} onChange={(event) => setReason(event.target.value)} disabled={pending} />
          <p className="connected-input-hint">{t("gateDecision.review.hint")}</p>
          <div className="connected-gate-actions">
            <button type="submit" className="connected-gate-action primary" disabled={pending || trimmed.length < REVIEW_MIN}>{t("gateDecision.review.send")}</button>
            <button type="button" className="connected-gate-action" disabled={pending} onClick={() => setReviewing(false)}>{t("gateDecision.review.cancel")}</button>
          </div>
        </form>
      )}
      {exception ? (
        <div className="connected-gate-review" data-state="exception_granted" role="status">
          <strong>{t("gateDecision.exception.title")}</strong>
          <p>{t("gateDecision.exception.body")}</p>
          {review?.reviewerNote && <p className="connected-gate-review-note" dir="auto">“{review.reviewerNote}”</p>}
          <button type="button" className="connected-gate-action primary" disabled={pending} onClick={() => onAction({ kind: "continue", label: t("gateDecision.exception.continue") })}>
            {t("gateDecision.exception.continue")}
          </button>
        </div>
      ) : review?.state === "open" ? (
        <div className="connected-gate-review" data-state="open" role="status">
          <strong>{t("gateDecision.review.requested")}</strong>
          <p>{t("gateDecision.review.requestedBody")}</p>
        </div>
      ) : review?.state === "upheld" ? (
        <div className="connected-gate-review" data-state="upheld" role="status">
          <strong>{t("gateDecision.review.upheld")}</strong>
          {review.reviewerNote && <p className="connected-gate-review-note" dir="auto">“{review.reviewerNote}”</p>}
        </div>
      ) : null}
    </section>
  );
}
