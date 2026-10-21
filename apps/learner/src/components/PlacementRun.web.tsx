import React from "react";
import { AssessmentInput } from "../connected/AssessmentInput.web";
import { MarkdownContent } from "./MarkdownContent";
import type { PlacementRunProps } from "./PlacementRun";
import { PLACEMENT_PANEL_ID } from "../client/presentation";
import { ReviewStatus } from "./ReviewStatus";
import { useI18n } from "../i18n";
import { abstainHint, placementReason, retakeState, unavailableMessage, usePlacementRun } from "./placementRunState";

/** Optional, bounded, resumable placement. Nothing is skipped until the learner
 * accepts a start point; placement never counts as reading a lesson. */
export function PlacementRun(props: PlacementRunProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const { enrollmentId } = props;
  const { view, item, answer, setAnswer, busy, error, loads, open, unavailable, draftProblem, actions, reviews, reply, appeal } = usePlacementRun(props);
  // After acceptance the run is over, but a reviewer's question about one of its
  // written answers may still be open (its episode can stay locked): keep a place to reply.
  if (view?.state === "accepted")
    return (
      <ReviewStatus loader={reviews} enrollmentId={enrollmentId} placementOnly openOnly title={t("placementRun.reviewTitle")}
        className="connected-reading-card connected-placement-followup" revision={loads} onReply={reply} />
    );
  if (unavailable)
    return (
      <section className="connected-reading-card connected-placement" aria-labelledby="placement-title">
        <p className="connected-eyebrow">{t("placementRun.eyebrowCaps")}</p>
        <h2 id="placement-title">{t("placementRun.title.unavailable")}</h2>
        <p role="alert" className="connected-error-text">{unavailableMessage(t)}</p>
        <div className="connected-actions">
          <button type="button" className="connected-link-button" disabled={busy} onClick={actions.retry}>
            {t("placementRun.retry")}
          </button>
        </div>
      </section>
    );
  if (!view || !open) return null;
  const used = view.run?.itemsUsed ?? 0;
  return (
    <section id={PLACEMENT_PANEL_ID} tabIndex={-1} className="connected-reading-card connected-placement" aria-labelledby="placement-title">
      <p className="connected-eyebrow">{t("placementRun.eyebrowCaps")}</p>
      {view.state === "offered" && (
        <>
          <h2 id="placement-title">{t("placementRun.offer.title")}</h2>
          <p>{t("placementRun.offer.body", { max: view.maxItems })}</p>
          <div className="connected-actions">
            <button type="button" className="connected-button" disabled={busy} onClick={actions.start}>
              {t("placementRun.findStart")}
            </button>
            <button type="button" className="connected-link-button" disabled={busy} onClick={actions.decline}>
              {t("placementRun.fromBeginning")}
            </button>
          </div>
        </>
      )}
      {view.state === "in_progress" && (
        <>
          <h2 id="placement-title">
            {t("placementRun.question", { n: Math.min(used + 1, view.maxItems), max: view.maxItems })}
          </h2>
          {!item && view.run?.nextItem && (
            <button type="button" className="connected-button" disabled={busy} onClick={actions.next}>
              {view.run.pendingChallengeId ? t("placementRun.resume") : t("placementRun.next")}
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
                  {t("placementRun.save")}
                </button>
                {item.question.allowAbstain !== false && (
                  <button type="button" className="connected-link-button" disabled={busy} aria-describedby="placement-abstain-hint" onClick={actions.abstain}>
                    {t("placementRun.abstain")}
                  </button>
                )}
              </div>
              {item.question.allowAbstain !== false && (
                <p className="connected-input-hint" id="placement-abstain-hint">
                  {abstainHint(t)}
                </p>
              )}
            </form>
          )}
          {!view.run?.nextItem && !item && (
            <p>{placementReason(view.run?.stopReason, i18n) ?? t("placementRun.complete")}</p>
          )}
          <button type="button" className="connected-link-button" disabled={busy} onClick={actions.finish}>
            {view.run?.nextItem || item ? t("placementRun.stopAndSee") : t("placementRun.seeResult")}
          </button>
        </>
      )}
      {view.state === "finished" && view.run && (
        <>
          <h2 id="placement-title">{t("placementRun.result.title")}</h2>
          <p>{placementReason(view.run.stopReason, i18n) ?? ""}</p>
          {view.run.proposal.exempt.length ? (
            <>
              <p>{t("placementRun.result.exempt")}</p>
              <ul>
                {view.run.proposal.exempt.map((e) => (
                  <li key={e.episodeId} dir="auto">
                    {e.title}
                  </li>
                ))}
              </ul>
              <p className="connected-muted">
                {t("placementRun.result.shown", {
                  list: view.run.proposal.demonstrated.map((d) => d.description).join(" "),
                })}
              </p>
            </>
          ) : (
            <p>{t("placementRun.result.nothing")}</p>
          )}
          {(view.run.proposal.pending?.length ?? 0) > 0 && (
            <p className="connected-muted">
              {t("placementRun.result.pending", {
                list: view.run.proposal.pending!.map((p) => p.description).join(" "),
              })}
            </p>
          )}
          <p className="connected-muted" dir="auto">
            {view.run.proposal.untestedNote}
          </p>
          <RetakePlacement retake={retakeState(view, i18n)} busy={busy} onRetake={actions.start} />
          <div className="connected-actions">
            {view.run.proposal.exempt.length > 0 && (
              <button type="button" className="connected-button" disabled={busy} onClick={actions.acceptProposal}>
                {view.run.proposal.startTitle
                  ? t("placementRun.startAt", { title: view.run.proposal.startTitle })
                  : t("placementRun.placeOutAll")}
              </button>
            )}
            <button
              type="button"
              className={view.run.proposal.exempt.length ? "connected-link-button" : "connected-button"}
              disabled={busy}
              onClick={actions.startFromBeginning}
            >
              {t("placementRun.fromBeginning")}
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
  const t = useI18n().t;
  if (!retake) return null;
  if (!retake.allowed) return <p className="connected-muted connected-placement-retake">{retake.text}</p>;
  return (
    <div className="connected-placement-retake">
      <p>{retake.text}</p>
      <button type="button" className="connected-link-button" disabled={busy} onClick={onRetake}>
        {t("placementRun.retake")}
      </button>
    </div>
  );
}
