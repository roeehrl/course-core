import { useEffect, useState } from "react";
import { CourseApiError, type Challenge, type ServerSnapshot } from "../../client/apiClient";
import { useT, type Translate } from "../../i18n";
import { answerResult } from "../answerFeedback";
import { answerPayload, isCode } from "../AssessmentInput.web";
import { codeSubmissionError } from "../code";

/** A page notice, rendered at display time so it follows a language switch while it shows. */
export type PageNotice = { render: (t: Translate) => string; tone?: "info" | "warning"; answer?: true };

/**
 * The last answer (or "I don't know yet") sent to a lesson's check. The server stops listing a
 * question once it is answered, so the card keeps it here to show the answer given, the feedback
 * and the help that follows in place, until the next question of the lesson arrives.
 */
export interface CheckAttempt {
  /** The question as it was asked. */
  challenge: Challenge;
  /** The answer as it was sent (empty for "I don't know yet"). */
  answer: string;
  kind: "answer" | "abstain";
  /** `checking` while the server grades; `failed` when it could not (the answer is kept). */
  status: "checking" | "answered" | "failed";
  /** The server's receipt, worded at display time (answerResult) so it follows a language switch. */
  receipt?: unknown;
  /** The question is a code exercise (its verdict is a code check's). */
  code?: boolean;
}

/** A refusal said under the answer field, where the learner can fix it: nothing was recorded. */
export type CheckFieldError = "copied" | "attemptRequired";

/**
 * What the lesson's check can do, as one value the host hands to the lesson and the lesson hands
 * to the check card untouched. Its owner may add fields without changing either of them.
 */
export interface CheckCommands {
  /** Starts the lesson's next check, or a given assessment the gate decision offers. */
  onStart: (assessmentId?: string) => void;
  onAnswer: (challenge: Challenge) => void;
  /** "I don't know yet": an explicit abstention that records no evidence. */
  onAbstain?: (challenge: Challenge) => void;
  /** Asks the server for the question's explanation (on a counted question it becomes practice). */
  onSolution: (challenge: Challenge) => void;
  /** Sends the answer again after the grader could not check it, or starts the next question
   * when the last one was recorded meanwhile. */
  onRetry?: (challenge: Challenge) => void;
  /**
   * Records with the server that a hint was shown on a counted question (it becomes practice).
   * Absent while the API has no such route: hints on a counted question are then not offered.
   */
  onHint?: (challenge: Challenge) => Promise<void>;
  /** A code answer is being graded. */
  checkingAnswer?: boolean;
  /** An answer to the open check is being saved; its options are locked only then. Defaults to `pending`. */
  savingAnswer?: boolean;
  confidence?: number | null;
  onConfidenceChange?: (value: number | null) => void;
  /** The last answer per lesson (episode id), with its feedback. */
  attempts?: Readonly<Record<string, CheckAttempt>>;
  /** A refusal to show under the answer field, per question (challenge id). */
  fieldErrors?: Readonly<Record<string, CheckFieldError>>;
  /** Explanations the learner opened, per question (challenge id), in Markdown. */
  explanations?: Readonly<Record<string, string>>;
  /** The question whose explanation is being fetched. */
  explaining?: string | null;
  /** Feedback the host still holds in its page notice, if any (no longer set by the check). */
  answerFeedback?: { text: string; tone: "info" | "warning" };
}

type Transact = <T>(action: () => Promise<T>) => Promise<T>;

/** A request saved on this device and sent once the page loaded again (apiClient `takeRecovered`). */
export interface RecoveredRequest {
  action: string;
  data: Record<string, unknown>;
  result: unknown;
  /** What the page showed for it when it was sent: for an answer, its question. */
  shown?: unknown;
}

/** Refusals that belong to the answer field; the request recorded nothing. */
const FIELD_ERRORS: Record<string, CheckFieldError> = {
  AGENT_AUTHORED_ANSWER: "copied",
  ABSTAIN_NOT_ALLOWED: "attemptRequired",
};
/** The grader could not check the answer: said in the check's feedback with a retry. Other
 * failures (offline, a slow sandbox start, a stale page) keep the host's page message and the
 * connection status, which hold the saved request and its retry. */
const GRADER_FAILED = new Set(["EVALUATOR_NOT_CONFIGURED", "INVALID_RESPONSE"]);

/**
 * The check's commands: answering, "I don't know yet", the explanation and starting a check, each
 * through the host's request lock. What the check says about an answer stays in the check: the
 * feedback, a refusal of the answer and a grader that could not run are kept here, per lesson and
 * question, and never put in the page notice.
 */
export function useCheckCommands({
  server,
  episodeId,
  challenge,
  placement,
  answer,
  command,
  run,
  setError,
  answerFeedback: feedback,
}: {
  server: ServerSnapshot | undefined;
  episodeId: string | undefined;
  challenge: Challenge | undefined;
  placement: boolean;
  answer: string;
  /** `shown`: kept with the request on the device, so a reload can show its result in place. */
  command: <T>(action: string, data: Record<string, unknown>, shown?: unknown) => Promise<T>;
  run: (action: () => Promise<unknown>) => void;
  transact?: Transact;
  transactQuiet?: Transact;
  setNotice: (notice: PageNotice | null) => void;
  setError: (message: string) => void;
  /** The feedback the page notice holds for the check, if it shows there. */
  answerFeedback?: { text: string; tone: "info" | "warning" };
}): { check: CheckCommands; recover: (recovered: RecoveredRequest) => boolean } {
  const t = useT();
  const [checkingAnswer, setCheckingAnswer] = useState(false);
  // An answer (or "I don't know yet") is being saved: only then are the check's options locked.
  // Any other request in flight (a companion message, marking a part read) leaves them usable,
  // so a tap on an option always chooses it.
  const [savingAnswer, setSavingAnswer] = useState(false);
  /** Optional confidence per open check. Never sent unless the learner chose a level. */
  const [confidence, setConfidence] = useState<Record<string, number | null>>({});
  const [attempts, setAttempts] = useState<Record<string, CheckAttempt>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, CheckFieldError>>({});
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  // A lesson's next question replaces the answer kept for it.
  const open = server?.activeChallenges;
  useEffect(() => {
    if (!open) return;
    setAttempts((all) => {
      const stale = Object.entries(all).filter(([lesson, kept]) =>
        open.some((row) => row.episodeId === lesson && row.challengeId !== kept.challenge.challengeId));
      if (!stale.length) return all;
      const next = { ...all };
      for (const [lesson] of stale) delete next[lesson];
      return next;
    });
  }, [open]);
  const keep = (lesson: string, attempt: CheckAttempt | null) =>
    setAttempts((all) => {
      const next = { ...all };
      if (attempt) next[lesson] = attempt;
      else delete next[lesson];
      return next;
    });
  const refuse = (challengeId: string, error: CheckFieldError | null) =>
    setFieldErrors((all) => {
      if ((all[challengeId] ?? null) === error) return all;
      const next = { ...all };
      if (error) next[challengeId] = error;
      else delete next[challengeId];
      return next;
    });
  /** Sends the answer or "I don't know yet"; the check's own refusals and a grader that could not
   * run are kept for the card, everything else goes to the host as before. */
  async function send(item: Challenge, kind: CheckAttempt["kind"], value: unknown) {
    const chosen = confidence[item.challengeId], code = kind === "answer" && isCode(item.question);
    const base = { challenge: item, answer: kind === "answer" ? answer : "", kind, ...(code ? { code } : {}) } as const;
    keep(item.episodeId, { ...base, status: "checking" });
    refuse(item.challengeId, null);
    if (code) setCheckingAnswer(true);
    setSavingAnswer(true);
    try {
      const receipt = await command("answers", { challengeId: item.challengeId, ...(kind === "abstain" ? { abstain: true } : { answer: value }), ...(chosen ? { confidence: chosen } : {}) }, item);
      // An unreadable receipt is the grader's failure, said in the check, never a guess at the grade.
      try {
        answerResult(receipt, code);
        keep(item.episodeId, { ...base, status: "answered", receipt });
      } catch {
        keep(item.episodeId, { ...base, status: "failed" });
      }
    } catch (cause) {
      const field = cause instanceof CourseApiError ? FIELD_ERRORS[cause.code] : undefined;
      if (field) {
        keep(item.episodeId, null);
        refuse(item.challengeId, field);
        return;
      }
      if (cause instanceof CourseApiError && GRADER_FAILED.has(cause.code)) {
        keep(item.episodeId, { ...base, status: "failed" });
        return;
      }
      keep(item.episodeId, null);
      throw cause;
    } finally {
      setCheckingAnswer(false);
      setSavingAnswer(false);
    }
  }
  async function submitAnswer(item: Challenge) {
    const payload = answerPayload(item.question, answer, t);
    if ("error" in payload) {
      setError(payload.error);
      return;
    }
    if (item.question.type === "code" || item.question.type === "code_repair") {
      const problem = codeSubmissionError(item.question.language, answer, t);
      if (problem) {
        setError(problem);
        return;
      }
    }
    await send(item, "answer", payload.value);
  }
  function startCheck(assessmentId?: string) {
    return run(() => {
      const recovery = server?.recovery?.find((r) => r.episodeId === episodeId)?.freshCheck;
      return recovery && !placement && !assessmentId
        ? command("adaptation/fresh-question", {
            episodeId, objectiveId: recovery.objectiveId, familyId: recovery.familyId, mode: "independent", expectedPlanRevision: server?.planRevision ?? 0,
          })
        : command("challenges", { episodeId, mode: placement ? "placement" : "independent", ...(assessmentId ? { assessmentId } : {}) });
    });
  }
  /** An answer sent again after a reload: shown under its question as if it had just been
   * answered here (the check's feedback slot and status region). False when the page kept no
   * question with it, or the result cannot be read: the host says it in its notice then. */
  function recover({ data, result, shown }: RecoveredRequest): boolean {
    const item = shown as Challenge | undefined;
    if (!item || typeof item !== "object" || typeof item.challengeId !== "string" || item.challengeId !== data.challengeId ||
      typeof item.episodeId !== "string" || !item.question || typeof item.question !== "object") return false;
    const code = isCode(item.question);
    try {
      answerResult(result, code);
    } catch {
      return false;
    }
    const abstain = data.abstain === true;
    keep(item.episodeId, {
      challenge: item,
      answer: !abstain && typeof data.answer === "string" ? data.answer : "",
      kind: abstain ? "abstain" : "answer",
      status: "answered",
      receipt: result,
      ...(code ? { code } : {}),
    });
    return true;
  }
  return {
    recover,
    check: {
      onStart: (assessmentId) => startCheck(assessmentId),
      onAnswer: (item) => run(() => submitAnswer(item)),
      onAbstain: (item) => run(() => send(item, "abstain", undefined)),
      onSolution: (item) =>
        run(async () => {
          setExplaining(item.challengeId);
          try {
            const result = await command<{ explanation: string }>("solution", { challengeId: item.challengeId });
            setExplanations((all) => ({ ...all, [item.challengeId]: result.explanation }));
          } finally {
            setExplaining(null);
          }
        }),
      onRetry: (item) => {
        if (server?.activeChallenges.some((row) => row.challengeId === item.challengeId)) run(() => submitAnswer(item));
        else startCheck();
      },
      checkingAnswer,
      savingAnswer,
      confidence: challenge ? confidence[challenge.challengeId] ?? null : null,
      onConfidenceChange: (value) => challenge && setConfidence((all) => ({ ...all, [challenge.challengeId]: value })),
      attempts,
      fieldErrors,
      explanations,
      explaining,
      ...(feedback ? { answerFeedback: feedback } : {}),
    },
  };
}
