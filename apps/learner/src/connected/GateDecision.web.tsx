import React from "react";
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
export function GateDecisionPanel({ gate, pending, onAction }: { gate: GateView; pending: boolean; onAction: (action: NextAction) => void }) {
  if (!gate.status) return null;
  const criteria = gate.criterionResults ?? [];
  const actions = gate.nextActions ?? [];
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
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
