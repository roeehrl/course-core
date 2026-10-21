import { useCallback, useEffect, useState } from "react";
import { useFirstLoadDone } from "../connected/firstLoad";
import type { CourseApi, Question } from "../client/apiClient";
import { CourseApiError, isAbortError } from "../client/apiClient";
import { answerPayload } from "../connected/answers";
import type { WrittenReview } from "./ReviewStatus";
import { useI18n, type LearnerTranslator, type MessageKey, type Translate } from "../i18n";

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
      demonstrated: { objectiveId: string; description: string; families: number;
        /** The placement questions that showed it, in the order answered. */
        supportingItems?: { assessmentId: string; familyId: string; prompt: string }[] }[];
      pending?: { objectiveId: string; description: string }[];
      /** Tried in this run but not shown, and why. */
      notShown?: { objectiveId: string; description: string; questions: number; reason: "answer_not_correct" | "help_used" | "more_evidence_needed" }[];
      /** Placeable objectives on the path that were never asked (at most 20 listed of untestedCount). */
      untested?: { objectiveId: string; description: string }[];
      untestedCount?: number;
      untestedNoteCode?: "not_a_judgement";
    };
  };
}

type PlacementTranslator = Pick<LearnerTranslator, "t" | "has" | "dateTime">;

/** Why a placement run stopped, from the server's stop reason; undefined for an unknown reason. */
export function placementReason(reason: string | undefined, i18n: Pick<LearnerTranslator, "t" | "has">) {
  const key = `placementRunState.reason.${reason ?? ""}` as MessageKey;
  return reason && i18n.has(key) ? i18n.t(key) : undefined;
}

export const unavailableMessage = (t: Translate) => t("placementRunState.unavailable");

export const abstainHint = (t: Translate) => t("placementRunState.abstainHint");

const when = (iso: string, i18n: PlacementTranslator) =>
  i18n.dateTime(iso, { dateStyle: "medium", timeStyle: "short" });

/** "Retake placement" is offered only when the server says a retest is allowed now; otherwise the
 * learner sees when it will be, or that every attempt is used. A retake asks only unseen questions
 * and never changes the result until a new start point is accepted. */
export function retakeState(
  view: PlacementView,
  i18n: PlacementTranslator,
): null | { allowed: true; text: string } | { allowed: false; text: string } {
  const maxRuns = view.maxRuns ?? 1, run = view.runNumber ?? 1;
  if (!view.retest || maxRuns <= 1) return null;
  if (view.retest.allowed)
    return {
      allowed: true,
      text: i18n.t("placementRunState.retake.allowed", { next: run + 1, max: maxRuns }),
    };
  if (view.retest.availableAt && Date.parse(view.retest.availableAt) > Date.now())
    return {
      allowed: false,
      text: i18n.t("placementRunState.retake.from", {
        date: when(view.retest.availableAt, i18n),
        next: run + 1,
        max: maxRuns,
      }),
    };
  if (run >= maxRuns) return { allowed: false, text: i18n.t("placementRunState.retake.used", { max: maxRuns }) };
  return null;
}

/** A code or code-repair item starts from its starter code, as it does in a lesson. */
const initialAnswer = (question: Question) =>
  question.type === "code" || question.type === "code_repair" ? (question.starterCode ?? "") : "";

export function usePlacementRun({ api, command, enrollmentId, firstEpisodeId, onFinished, onOpenChange }: PlacementRunProps) {
  const i18n = useI18n();
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
  // The first read can fail (offline, server down). There is no view to show yet, so the panel
  // says placement is unavailable and offers a retry instead of disappearing.
  const [unavailable, setUnavailable] = useState(false);
  const firstLoad = useCallback(async () => {
    setUnavailable(false);
    try {
      await load();
    } catch (cause) {
      if (!isAbortError(cause)) setUnavailable(true);
    }
  }, [load]);
  useEffect(() => {
    void firstLoad();
  }, [firstLoad]);
  useFirstLoadDone("placement", view !== undefined || unavailable);
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
          ? i18n.t("placementRunState.error.PLACEMENT_AFTER_STUDY")
          : cause instanceof CourseApiError && cause.code === "PLACEMENT_RUN_LIMIT"
            ? i18n.t("placementRunState.error.PLACEMENT_RUN_LIMIT")
            : cause instanceof CourseApiError && cause.code === "PLACEMENT_RETEST_COOLDOWN"
              ? typeof cause.details?.availableAt === "string"
                ? i18n.t("placementRunState.error.cooldownUntil", { date: when(cause.details.availableAt, i18n) })
                : i18n.t("placementRunState.error.PLACEMENT_RETEST_COOLDOWN")
              : i18n.t("placementRunState.error.generic"),
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
    retry: () => {
      setBusy(true);
      void firstLoad().finally(() => setBusy(false));
    },
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
  return { view, item, answer, setAnswer, busy, error, loads, open, unavailable: !view && unavailable, draftProblem, actions, reviews, reply, appeal };
}
