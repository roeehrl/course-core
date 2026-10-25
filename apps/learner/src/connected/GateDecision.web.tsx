import React, { useId, useState } from "react";
import type { NextAction } from "@course-core/sdk";
import type { GateMessage, GateView } from "../client/apiClient";
import { englishTranslator, useI18n, useT, type LearnerTranslator, type MessageKey, type Translate } from "../i18n";

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
 * A decision sentence in the learner's language: the server's message code translated with its
 * parameters, or the server's English text when the code is unknown to this app version. Lists of
 * course text are quoted and joined for the locale; a nested detail is translated first.
 */
export function gateText(message: GateMessage | null | undefined, fallback: string, i18n: Pick<LearnerTranslator, "t" | "has" | "list">): string {
  if (!message) return fallback;
  const key = `gateDecision.msg.${message.code}` as MessageKey;
  if (!i18n.has(key)) return fallback;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.params ?? {}))
    params[name] = Array.isArray(value) ? i18n.list(value.map((text) => i18n.t("gateDecision.quoted", { text })), "unit") : value;
  if (message.detail) {
    const detail = gateText(message.detail, "", i18n);
    if (!detail) return fallback;
    params.detail = detail;
  }
  return i18n.t(key, params);
}

/** Two decision sentences say the same, ignoring direction marks, spacing and a final full stop. */
const same = (a: string, b: string) => {
  const plain = (text: string) => text.replace(/[\u200e\u200f\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
  return plain(a) === plain(b);
};

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
  const i18n = useI18n();
  const [reviewing, setReviewing] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  if (!gate.status) return null;
  const criteria = gate.criterionResults ?? [];
  const review = gate.review ?? null, exception = gate.exception ?? null;
  // While a request is open or an exception stands, the appeal step is replaced by its status.
  const messages = gate.messages ?? null;
  // Each step keeps its server position, which is how its message code is found.
  const actions = (gate.nextActions ?? []).map((action, index) => ({ ...action, label: gateText(messages?.actions[index], action.label, i18n) }))
    .filter((action) => action.kind !== "appeal" || (onRequestReview && review?.state !== "open" && !exception));
  // A translated criterion still says when its evidence awaits review, as the English text does.
  const criterionText = (criterion: (typeof criteria)[number], state: string) => {
    const message = messages?.criteria[criterion.criterionId], text = gateText(message, "", i18n);
    if (!text) return criterion.reason;
    return state === "pending" ? `${text} ${t("gateDecision.awaitingReview")}` : text;
  };
  // Each sentence once (0.1.58 qualification: the card said "Needs independent success in 2 item
  // families for …" two or three times). The reason is left out when a criterion below says the
  // same, and two criteria that read the same are listed once.
  const rows: { criterion: (typeof criteria)[number]; state: "met" | "pending" | "unmet"; text: string }[] = [];
  for (const criterion of criteria) {
    const state = criterion.met === true ? "met" as const : criterion.met === "pending" ? "pending" as const : "unmet" as const;
    const text = criterionText(criterion, state);
    if (!rows.some((row) => row.state === state && same(row.text, text))) rows.push({ criterion, state, text });
  }
  const reasonText = gate.learnerVisibleReason ? gateText(messages?.reason, gate.learnerVisibleReason, i18n) : "";
  const showReason = Boolean(reasonText) && !rows.some((row) => same(row.text, reasonText));
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
      {showReason && <p className="connected-gate-reason" dir="auto">{reasonText}</p>}
      {rows.length > 0 && (
        <ul className="connected-gate-criteria" aria-label={t("gateDecision.criteria")}>
          {rows.map(({ criterion, state, text }) => (
            <li key={criterion.criterionId} data-state={state}>
              <strong>{t(`gateDecision.criterion.${state}`)}</strong>
              <span dir="auto">{text}</span>
            </li>
          ))}
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
            <button type="submit" className="connected-gate-action primary" data-usability="next" disabled={pending || trimmed.length < REVIEW_MIN}>{t("gateDecision.review.send")}</button>
            <button type="button" className="connected-gate-action" disabled={pending} onClick={() => setReviewing(false)}>{t("gateDecision.review.cancel")}</button>
          </div>
        </form>
      )}
      {exception ? (
        <div className="connected-gate-review" data-state="exception_granted" role="status">
          <strong>{t("gateDecision.exception.title")}</strong>
          <p>{t("gateDecision.exception.body")}</p>
          {review?.reviewerNote && <p className="connected-gate-review-note" dir="auto">“{review.reviewerNote}”</p>}
          <button type="button" className="connected-gate-action primary" data-usability="next" disabled={pending} onClick={() => onAction({ kind: "continue", label: t("gateDecision.exception.continue") })}>
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
