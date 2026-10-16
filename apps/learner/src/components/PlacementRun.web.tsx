import React from "react";
import { AssessmentInput } from "../connected/AssessmentInput.web";
import { MarkdownContent } from "./MarkdownContent";
import type { PlacementRunProps } from "./PlacementRun";
import { PLACEMENT_PANEL_ID } from "../client/presentation";
import { ReviewStatus } from "./ReviewStatus";
import { ABSTAIN_HINT, UNAVAILABLE_MESSAGE, placementReasons as reasons, retakeState, usePlacementRun } from "./placementRunState";

/** Optional, bounded, resumable placement. Nothing is skipped until the learner
 * accepts a start point; placement never counts as reading a lesson. */
export function PlacementRun(props: PlacementRunProps) {
  const { enrollmentId } = props;
  const { view, item, answer, setAnswer, busy, error, loads, open, unavailable, draftProblem, actions, reviews, reply, appeal } = usePlacementRun(props);
  // After acceptance the run is over, but a reviewer's question about one of its
  // written answers may still be open (its episode can stay locked): keep a place to reply.
  if (view?.state === "accepted")
    return (
      <ReviewStatus loader={reviews} enrollmentId={enrollmentId} placementOnly openOnly title="Placement answers a reviewer asked about"
        className="connected-reading-card connected-placement-followup" revision={loads} onReply={reply} />
    );
  if (unavailable)
    return (
      <section className="connected-reading-card connected-placement" aria-labelledby="placement-title">
        <p className="connected-eyebrow">OPTIONAL · FIND YOUR STARTING POINT</p>
        <h2 id="placement-title">Placement</h2>
        <p role="alert" className="connected-error-text">{UNAVAILABLE_MESSAGE}</p>
        <div className="connected-actions">
          <button type="button" className="connected-link-button" disabled={busy} onClick={actions.retry}>
            Try placement again
          </button>
        </div>
      </section>
    );
  if (!view || !open) return null;
  const used = view.run?.itemsUsed ?? 0;
  return (
    <section id={PLACEMENT_PANEL_ID} tabIndex={-1} className="connected-reading-card connected-placement" aria-labelledby="placement-title">
      <p className="connected-eyebrow">OPTIONAL · FIND YOUR STARTING POINT</p>
      {view.state === "offered" && (
        <>
          <h2 id="placement-title">Already know some of this?</h2>
          <p>
            Answer up to {view.maxItems} short questions without help. If you show what an early part of the course
            teaches, you can start later. Nothing is skipped until you choose, you can stop at any time, and you can
            always revisit material you skip. Declining is completely fine.
          </p>
          <div className="connected-actions">
            <button type="button" className="connected-button" disabled={busy} onClick={actions.start}>
              Find my starting point
            </button>
            <button type="button" className="connected-link-button" disabled={busy} onClick={actions.decline}>
              Start from the beginning
            </button>
          </div>
        </>
      )}
      {view.state === "in_progress" && (
        <>
          <h2 id="placement-title">Placement question {Math.min(used + 1, view.maxItems)} of at most {view.maxItems}</h2>
          {!item && view.run?.nextItem && (
            <button type="button" className="connected-button" disabled={busy} onClick={actions.next}>
              {view.run.pendingChallengeId ? "Resume my question" : "Next question"}
            </button>
          )}
          {item && (
            <form
              className="connected-placement-item"
              onSubmit={(e) => {
                e.preventDefault();
                actions.answer();
              }}
            >
              <MarkdownContent markdown={item.question.prompt} />
              <AssessmentInput question={item.question} answer={answer} pending={busy} onChange={setAnswer} />
              <div className="connected-actions">
                <button type="submit" className="connected-button" disabled={busy || Boolean(draftProblem)}>
                  Save answer
                </button>
                {item.question.allowAbstain !== false && (
                  <button type="button" className="connected-link-button" disabled={busy} aria-describedby="placement-abstain-hint" onClick={actions.abstain}>
                    I don't know yet
                  </button>
                )}
              </div>
              {item.question.allowAbstain !== false && (
                <p className="connected-input-hint" id="placement-abstain-hint">
                  {ABSTAIN_HINT}
                </p>
              )}
            </form>
          )}
          {!view.run?.nextItem && !item && <p>{reasons[view.run?.stopReason ?? ""] ?? "Placement is complete."}</p>}
          <button type="button" className="connected-link-button" disabled={busy} onClick={actions.finish}>
            {view.run?.nextItem || item ? "Stop and see my result" : "See my result"}
          </button>
        </>
      )}
      {view.state === "finished" && view.run && (
        <>
          <h2 id="placement-title">Your placement result</h2>
          <p>{reasons[view.run.stopReason] ?? ""}</p>
          {view.run.proposal.exempt.length ? (
            <>
              <p>You showed what these parts teach and can place out of them:</p>
              <ul>
                {view.run.proposal.exempt.map((e) => <li key={e.episodeId}>{e.title}</li>)}
              </ul>
              <p className="connected-muted">
                Shown independently: {view.run.proposal.demonstrated.map((d) => d.description).join(" ")}
              </p>
            </>
          ) : (
            <p>Nothing will be skipped. Starting from the beginning is the right path.</p>
          )}
          {(view.run.proposal.pending?.length ?? 0) > 0 && (
            <p className="connected-muted">
              Waiting for evaluation, not marked wrong: {view.run.proposal.pending!.map((p) => p.description).join(" ")}
            </p>
          )}
          <p className="connected-muted">{view.run.proposal.untestedNote}</p>
          <RetakePlacement retake={retakeState(view)} busy={busy} onRetake={actions.start} />
          <div className="connected-actions">
            {view.run.proposal.exempt.length > 0 && (
              <button type="button" className="connected-button" disabled={busy} onClick={actions.acceptProposal}>
                {view.run.proposal.startTitle ? `Start at “${view.run.proposal.startTitle}”` : "Place out of everything shown"}
              </button>
            )}
            <button
              type="button"
              className={view.run.proposal.exempt.length ? "connected-link-button" : "connected-button"}
              disabled={busy}
              onClick={actions.startFromBeginning}
            >
              Start from the beginning
            </button>
          </div>
        </>
      )}
      {(view.state === "in_progress" || view.state === "finished") && (
        <ReviewStatus loader={reviews} enrollmentId={enrollmentId} placementOnly revision={loads} onReply={reply} onAppeal={appeal} />
      )}
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}

function RetakePlacement({ retake, busy, onRetake }: { retake: ReturnType<typeof retakeState>; busy: boolean; onRetake: () => void }) {
  if (!retake) return null;
  if (!retake.allowed) return <p className="connected-muted connected-placement-retake">{retake.text}</p>;
  return (
    <div className="connected-placement-retake">
      <p>{retake.text}</p>
      <button type="button" className="connected-link-button" disabled={busy} onClick={onRetake}>
        Retake placement
      </button>
    </div>
  );
}
