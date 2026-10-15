import React, { useId, useState } from "react";
import type { NextAction } from "@course-core/sdk";
import type { GateView } from "../client/apiClient";

/** Learner wording for the five server decision statuses. */
export const GATE_STATUS_LABELS = {
  ready: "Ready to continue",
  needs_evidence: "More evidence needed",
  needs_help: "Let's get you some help",
  under_review: "Under review",
  closed_with_gaps: "Closed with gaps",
} as const;
const CRITERION_STATE = { met: "Done", pending: "Waiting for review", unmet: "Still needed" } as const;

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
        <p className="connected-eyebrow">CHECKPOINT DECISION</p>
        <h3 id="connected-gate-title" className="connected-gate-status" aria-live="polite">
          <span className="connected-gate-dot" aria-hidden="true" />
          {GATE_STATUS_LABELS[gate.status]}
        </h3>
      </div>
      {gate.learnerVisibleReason && <p className="connected-gate-reason">{gate.learnerVisibleReason}</p>}
      {criteria.length > 0 && (
        <ul className="connected-gate-criteria" aria-label="Readiness criteria">
          {criteria.map((criterion) => {
            const state = criterion.met === true ? "met" : criterion.met === "pending" ? "pending" : "unmet";
            return (
              <li key={criterion.criterionId} data-state={state}>
                <strong>{CRITERION_STATE[state]}</strong>
                <span>{criterion.reason}</span>
              </li>
            );
          })}
        </ul>
      )}
      {actions.length > 0 && (
        <div className="connected-gate-actions" role="group" aria-label="Next steps">
          {actions.map((action, index) => action.kind === "await_review" ? (
            <p key={`await:${index}`} className="connected-gate-wait">{action.label}</p>
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
              {action.label}
            </button>
          ))}
        </div>
      )}
      {reviewing && onRequestReview && !exception && review?.state !== "open" && (
        <form
          className="connected-gate-review-form"
          aria-label="Ask for a review of this decision"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length < REVIEW_MIN || pending) return;
            void onRequestReview(trimmed).then(() => { setReviewing(false); setReason(""); }, () => undefined);
          }}
        >
          <label htmlFor={reasonId}>Why should a staff member look at this decision again?</label>
          <textarea id={reasonId} value={reason} maxLength={REVIEW_MAX} rows={3} onChange={(event) => setReason(event.target.value)} disabled={pending} />
          <p className="connected-input-hint">A reviewer reads your reason and the record above. Asking does not change your status by itself.</p>
          <div className="connected-gate-actions">
            <button type="submit" className="connected-gate-action primary" disabled={pending || trimmed.length < REVIEW_MIN}>Send review request</button>
            <button type="button" className="connected-gate-action" disabled={pending} onClick={() => setReviewing(false)}>Cancel</button>
          </div>
        </form>
      )}
      {exception ? (
        <div className="connected-gate-review" data-state="exception_granted" role="status">
          <strong>Staff exception granted</strong>
          <p>A staff reviewer authorized you to continue past this checkpoint. This is not a pass: the criteria still open stay recorded as gaps.</p>
          {review?.reviewerNote && <p className="connected-gate-review-note">“{review.reviewerNote}”</p>}
          <button type="button" className="connected-gate-action primary" disabled={pending} onClick={() => onAction({ kind: "continue", label: "Continue under the exception" })}>
            Continue under the exception
          </button>
        </div>
      ) : review?.state === "open" ? (
        <div className="connected-gate-review" data-state="open" role="status">
          <strong>Review requested</strong>
          <p>A staff member will look at this decision and reply here. Your saved work is unchanged meanwhile.</p>
        </div>
      ) : review?.state === "upheld" ? (
        <div className="connected-gate-review" data-state="upheld" role="status">
          <strong>Review completed: the decision stands</strong>
          {review.reviewerNote && <p className="connected-gate-review-note">“{review.reviewerNote}”</p>}
        </div>
      ) : null}
    </section>
  );
}
