import { useCallback, useEffect, useState } from "react";
import type { CourseApi, Question } from "../client/apiClient";
import { CourseApiError, isAbortError } from "../client/apiClient";
import { answerPayload } from "../connected/answers";
import type { WrittenReview } from "./ReviewStatus";

/** Placement state and actions shared by the web and native placement panels, so both follow the
 * same server contract: optional, bounded, resumable, and nothing skipped until a start is accepted. */
export interface PlacementRunProps {
  api: Pick<CourseApi, "request">;
  command: <T>(action: string, data: Record<string, unknown>) => Promise<T>;
  enrollmentId: string;
  firstEpisodeId: string;
  onFinished: () => void;
  /** Reports whether the placement panel (the roadmap card's target) is on screen:
   * offered before study, in progress, or finished and awaiting a choice. */
  onOpenChange?: (open: boolean) => void;
}

export interface PlacementView {
  available: boolean;
  maxItems: number;
  studied: boolean;
  state: "offered" | "unavailable" | "declined" | "in_progress" | "finished" | "accepted";
  /** Present when staff settings allow numbered placement runs. */
  runNumber?: number | null;
  maxRuns?: number;
  retest?: { allowed: boolean; availableAt: string | null };
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

export const placementReasons: Record<string, string> = {
  not_demonstrated: "One answer was incorrect, assisted or marked “I don't know yet”, so placement stopped there. That topic stays on your path.",
  protected_episode: "The next part of the course is a required experience everyone completes.",
  not_placeable: "The next part of the course is not covered by placement.",
  no_fresh_items: "There are no more unseen placement questions for the next topic.",
  item_limit: "You reached this course's placement question limit.",
  course_covered: "You answered every placement topic.",
  stopped_by_learner: "You stopped placement. Unanswered topics stay on your path.",
  pending_evaluation: "An answer is still waiting to be evaluated. It is not counted as wrong; until it is evaluated, that topic stays on your path.",
};

export const ABSTAIN_HINT = "“I don't know yet” is not a wrong answer. Placement stops at that topic and it stays on your path.";

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** "Retake placement" is offered only when the server says a retest is allowed now; otherwise the
 * learner sees when it will be, or that every attempt is used. A retake asks only unseen questions
 * and never changes the result until a new start point is accepted. */
export function retakeState(view: PlacementView): null | { allowed: true; text: string } | { allowed: false; text: string } {
  const maxRuns = view.maxRuns ?? 1, run = view.runNumber ?? 1;
  if (!view.retest || maxRuns <= 1) return null;
  if (view.retest.allowed)
    return {
      allowed: true,
      text: `You can retake placement once you are ready: attempt ${run + 1} of ${maxRuns}. It uses only questions you have not seen, and nothing changes until you choose a start point.`,
    };
  if (view.retest.availableAt && Date.parse(view.retest.availableAt) > Date.now())
    return { allowed: false, text: `You can retake placement from ${when(view.retest.availableAt)} (attempt ${run + 1} of ${maxRuns}).` };
  if (run >= maxRuns) return { allowed: false, text: `You have used all ${maxRuns} placement attempts this course allows.` };
  return null;
}

/** A code or code-repair item starts from its starter code, as it does in a lesson. */
const initialAnswer = (question: Question) =>
  question.type === "code" || question.type === "code_repair" ? (question.starterCode ?? "") : "";

export function usePlacementRun({ api, command, enrollmentId, firstEpisodeId, onFinished, onOpenChange }: PlacementRunProps) {
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
          : cause instanceof CourseApiError && cause.code === "PLACEMENT_RUN_LIMIT"
            ? "You have used every placement attempt this course allows. Your result above still stands."
            : cause instanceof CourseApiError && cause.code === "PLACEMENT_RETEST_COOLDOWN"
              ? `Placement can be retaken${typeof cause.details?.availableAt === "string" ? ` from ${when(cause.details.availableAt)}` : " later"}. Your result above still stands.`
              : "That did not go through. Your progress is saved; try again.",
      );
      if (cause instanceof CourseApiError && cause.code.startsWith("PLACEMENT_")) await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  /** Sends the shown item's answer, or an explicit "I don't know yet", then offers the next item. */
  async function submit(body: { answer: unknown } | { abstain: true }) {
    if (!item) return;
    await command("answers", { challengeId: item.challengeId, ...body });
    setItem(undefined);
    const next = await load();
    if (next.run?.nextItem) await issueNext(next);
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
    setAnswer(initialAnswer(issued.question));
    setItem(issued);
  }
  /** Why the current draft cannot be sent yet, or "" when it can. */
  const draft = item ? answerPayload(item.question, answer) : undefined;
  const draftProblem = draft && "error" in draft ? draft.error : "";
  const actions = {
    start: () => void act(async () => { await command("placement/start", {}); await issueNext(await load()); }),
    decline: () => void act(async () => { await command("placement/decline", {}); await load(); onFinished(); }),
    next: () => void act(async () => { if (view) await issueNext(view); }),
    /** Validates the draft first; a draft that cannot be sent is explained, never submitted. */
    answer: () => {
      if (!item) return;
      const payload = answerPayload(item.question, answer);
      if ("error" in payload) return setError(payload.error);
      void act(async () => submit({ answer: payload.value }));
    },
    abstain: () => void act(async () => submit({ abstain: true })),
    finish: () => void act(async () => { setItem(undefined); await command("placement/finish", {}); await load(); }),
    acceptProposal: () => void act(async () => {
      const start = view?.run?.proposal.startEpisodeId;
      await command("placement/accept", start ? { startEpisodeId: start } : {});
      await load();
      onFinished();
    }),
    startFromBeginning: () => void act(async () => { await command("placement/accept", { startEpisodeId: firstEpisodeId }); await load(); onFinished(); }),
  };
  return { view, item, answer, setAnswer, busy, error, loads, open, draftProblem, actions, reviews, reply, appeal };
}
