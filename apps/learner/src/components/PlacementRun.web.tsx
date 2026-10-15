import React, { useCallback, useEffect, useState } from "react";
import type { CourseApi, Question } from "../client/apiClient";
import { CourseApiError, isAbortError } from "../client/apiClient";
import { ChoiceList, Field } from "./ui";
import { CodeEditor } from "./CodeEditor";
import { MarkdownContent } from "./MarkdownContent";
import type { PlacementRunProps } from "./PlacementRun";
import { PLACEMENT_PANEL_ID } from "../client/presentation";
import { ReviewStatus, type WrittenReview } from "./ReviewStatus";

interface PlacementView {
  available: boolean;
  maxItems: number;
  studied: boolean;
  state: "offered" | "unavailable" | "declined" | "in_progress" | "finished" | "accepted";
  run: null | {
    itemsUsed: number;
    pendingChallengeId: string | null;
    nextItem: { episodeId: string; assessmentId: string } | null;
    stopReason: string;
    proposal: {
      exempt: { episodeId: string; title: string }[];
      startEpisodeId: string | null;
      startTitle: string | null;
      demonstrated: { objectiveId: string; description: string; families: number }[];
      pending?: { objectiveId: string; description: string }[];
      untestedNote: string;
    };
  };
}
const reasons: Record<string, string> = {
  not_demonstrated: "One answer was incorrect or assisted, so placement stopped there. That topic stays on your path.",
  protected_episode: "The next part of the course is a required experience everyone completes.",
  not_placeable: "The next part of the course is not covered by placement.",
  no_fresh_items: "There are no more unseen placement questions for the next topic.",
  item_limit: "You reached this course's placement question limit.",
  course_covered: "You answered every placement topic.",
  stopped_by_learner: "You stopped placement. Unanswered topics stay on your path.",
  pending_evaluation: "An answer is still waiting to be evaluated. It is not counted as wrong; until it is evaluated, that topic stays on your path.",
};

/** Optional, bounded, resumable placement. Nothing is skipped until the learner
 * accepts a start point; placement never counts as reading a lesson. */
export function PlacementRun({ api, command, enrollmentId, firstEpisodeId, onFinished, onOpenChange }: PlacementRunProps) {
  const [view, setView] = useState<PlacementView>();
  const [item, setItem] = useState<{ challengeId: string; question: Question }>();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loads, setLoads] = useState(0);
  const load = useCallback(async () => {
    const next = await (api as CourseApi).request<PlacementView>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/placement`);
    setView(next);
    setLoads((n) => n + 1);
    return next;
  }, [api, enrollmentId]);
  // Written placement answers can be reviewed (and questioned) while their episode is still locked.
  const reviews = useCallback(
    async (id: string, signal: AbortSignal) =>
      (await (api as CourseApi).request<{ reviews: WrittenReview[] }>(`/api/enrollments/${encodeURIComponent(id)}/reviews`, "GET", undefined, { signal })).reviews,
    [api],
  );
  const reply = async (attemptId: string, text: string) => {
    await command(`reviews/${encodeURIComponent(attemptId)}/reply`, { answer: text });
    await load();
  };
  // Appeal a judged placement answer exactly like any other written answer.
  const appeal = async (attemptId: string, reason: string) => {
    await command(`reviews/${encodeURIComponent(attemptId)}/appeal`, { reason });
    await load();
  };
  useEffect(() => {
    void load().catch((cause) => !isAbortError(cause) && setError("Placement is unavailable right now. You can start learning normally."));
  }, [load]);
  const open = Boolean(
    view?.available && (view.state === "in_progress" || view.state === "finished" || (view.state === "offered" && !view.studied)),
  );
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof CourseApiError && cause.code === "PLACEMENT_AFTER_STUDY"
          ? "Placement is only offered before you start studying."
          : "That did not go through. Your progress is saved; try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function issueNext(current: PlacementView) {
    const next = current.run?.nextItem;
    if (!next) return setItem(undefined);
    // Resume an interrupted item; the server refuses to issue a second one.
    const issued = await command<{ challengeId: string; question: Question }>("challenges", {
      episodeId: next.episodeId,
      assessmentId: next.assessmentId,
      mode: "placement",
    }).catch(async (cause) => {
      if (cause instanceof CourseApiError && cause.code === "PLACEMENT_ITEM_PENDING") {
        const snapshot = await (api as CourseApi).request<{ activeChallenges: { challengeId: string; question: Question; mode: string }[] }>(
          `/api/enrollments/${encodeURIComponent(enrollmentId)}`,
        );
        const pending = snapshot.activeChallenges.find((c) => c.mode === "placement");
        if (pending) return { challengeId: pending.challengeId, question: pending.question };
      }
      throw cause;
    });
    setAnswer("");
    setItem(issued);
  }
  // After acceptance the run is over, but a reviewer's question about one of its
  // written answers may still be open (its episode can stay locked): keep a place to reply.
  if (view?.state === "accepted")
    return (
      <ReviewStatus loader={reviews} enrollmentId={enrollmentId} placementOnly openOnly title="Placement answers a reviewer asked about"
        className="connected-reading-card connected-placement-followup" revision={loads} onReply={reply} />
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
            <button type="button" className="connected-button" disabled={busy} onClick={() => void act(async () => { await command("placement/start", {}); await issueNext(await load()); })}>
              Find my starting point
            </button>
            <button type="button" className="connected-link-button" disabled={busy} onClick={() => void act(async () => { await command("placement/decline", {}); await load(); onFinished(); })}>
              Start from the beginning
            </button>
          </div>
        </>
      )}
      {view.state === "in_progress" && (
        <>
          <h2 id="placement-title">Placement question {Math.min(used + 1, view.maxItems)} of at most {view.maxItems}</h2>
          {!item && view.run?.nextItem && (
            <button type="button" className="connected-button" disabled={busy} onClick={() => void act(async () => issueNext(view))}>
              {view.run.pendingChallengeId ? "Resume my question" : "Next question"}
            </button>
          )}
          {item && (
            <form
              className="connected-placement-item"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const value = item.question.type === "numeric" ? Number(answer.trim()) : answer;
                  await command("answers", { challengeId: item.challengeId, answer: value });
                  setItem(undefined);
                  const next = await load();
                  if (next.run?.nextItem) await issueNext(next);
                });
              }}
            >
              <MarkdownContent markdown={item.question.prompt} />
              {item.question.type === "choice" ? (
                <ChoiceList
                  label="Your answer"
                  options={(item.question.options ?? []).map((o) => ({ id: o.id, label: o.text }))}
                  value={answer}
                  onChange={setAnswer}
                  disabled={busy}
                />
              ) : item.question.type === "rubric" ? (
                <>
                  <div className="connected-rubric">
                    <p className="connected-eyebrow">A REVIEWER WILL LOOK FOR</p>
                    <ul>
                      {item.question.criteria.map((c) => (
                        <li key={c.id}>
                          {c.description}
                          {!c.required && <span className="connected-muted"> (optional)</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Field label="Your explanation" value={answer} onChangeText={setAnswer} multiline numberOfLines={6} maxLength={8000} editable={!busy} />
                </>
              ) : item.question.type === "code" ? (
                <CodeEditor language={item.question.language} value={answer} onChange={setAnswer} disabled={busy} />
              ) : (
                <Field label="Your numeric answer" value={answer} onChangeText={setAnswer} keyboardType="numeric" />
              )}
              <button type="submit" className="connected-button" disabled={busy || !answer.trim()}>
                Save answer
              </button>
            </form>
          )}
          {!view.run?.nextItem && !item && <p>{reasons[view.run?.stopReason ?? ""] ?? "Placement is complete."}</p>}
          <button
            type="button"
            className="connected-link-button"
            disabled={busy}
            onClick={() => void act(async () => { setItem(undefined); await command("placement/finish", {}); await load(); })}
          >
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
          <div className="connected-actions">
            {view.run.proposal.exempt.length > 0 && (
              <button
                type="button"
                className="connected-button"
                disabled={busy}
                onClick={() => void act(async () => {
                  await command("placement/accept", view.run!.proposal.startEpisodeId ? { startEpisodeId: view.run!.proposal.startEpisodeId } : {});
                  await load();
                  onFinished();
                })}
              >
                {view.run.proposal.startTitle ? `Start at “${view.run.proposal.startTitle}”` : "Place out of everything shown"}
              </button>
            )}
            <button
              type="button"
              className={view.run.proposal.exempt.length ? "connected-link-button" : "connected-button"}
              disabled={busy}
              onClick={() => void act(async () => { await command("placement/accept", { startEpisodeId: firstEpisodeId }); await load(); onFinished(); })}
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
