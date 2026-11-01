import { useState } from "react";
import type { Challenge, ServerSnapshot } from "../../client/apiClient";
import { useT, type Translate } from "../../i18n";
import { answerFeedback, answerFeedbackTone } from "../answerFeedback";
import { answerPayload } from "../AssessmentInput.web";
import { codeSubmissionError } from "../code";

/** A page notice, rendered at display time so it follows a language switch while it shows. */
export type PageNotice = { render: (t: Translate) => string; tone?: "info" | "warning"; answer?: true };

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
  onSolution: (challenge: Challenge) => void;
  /** A code answer is being graded. */
  checkingAnswer?: boolean;
  /** An answer to the open check is being saved; its options are locked only then. Defaults to `pending`. */
  savingAnswer?: boolean;
  confidence?: number | null;
  onConfidenceChange?: (value: number | null) => void;
  /** The server's feedback on the answer just checked, shown in the check beside its heading. */
  answerFeedback?: { text: string; tone: "info" | "warning" };
}

type Transact = <T>(action: () => Promise<T>) => Promise<T>;

/**
 * The check's commands: answering, "I don't know yet", the explanation and starting a check,
 * each through the host's request lock, with the feedback kept in the page notice.
 */
export function useCheckCommands({
  server,
  episodeId,
  challenge,
  placement,
  answer,
  command,
  run,
  setNotice,
  setError,
  answerFeedback: feedback,
}: {
  server: ServerSnapshot | undefined;
  episodeId: string | undefined;
  challenge: Challenge | undefined;
  placement: boolean;
  answer: string;
  command: <T>(action: string, data: Record<string, unknown>) => Promise<T>;
  run: (action: () => Promise<unknown>) => void;
  transact?: Transact;
  transactQuiet?: Transact;
  setNotice: (notice: PageNotice | null) => void;
  setError: (message: string) => void;
  /** The feedback the page notice holds for the check, if it shows there. */
  answerFeedback?: { text: string; tone: "info" | "warning" };
}): { check: CheckCommands } {
  const t = useT();
  const [checkingAnswer, setCheckingAnswer] = useState(false);
  // An answer (or "I don't know yet") is being saved: only then are the check's options locked.
  // Any other request in flight (a companion message, marking a part read) leaves them usable,
  // so a tap on an option always chooses it.
  const [savingAnswer, setSavingAnswer] = useState(false);
  /** Optional confidence per open check. Never sent unless the learner chose a level. */
  const [confidence, setConfidence] = useState<Record<string, number | null>>({});
  async function submitAnswer(item: Challenge) {
    const payload = answerPayload(item.question, answer, t);
    if ("error" in payload) {
      setError(payload.error);
      return;
    }
    const value = payload.value, chosen = confidence[item.challengeId];
    if (item.question.type === "code" || item.question.type === "code_repair") {
      const problem = codeSubmissionError(item.question.language, answer, t);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setCheckingAnswer(true);
    setSavingAnswer(true);
    try {
      const result = await command<{
        result: { passed: boolean; explanation: string; independent: boolean };
      }>("answers", { challengeId: item.challengeId, answer: value, ...(chosen ? { confidence: chosen } : {}) });
      setNotice({ render: (t) => answerFeedback(result, item.question.type === "code" || item.question.type === "code_repair", t), tone: answerFeedbackTone(result), answer: true });
    } finally {
      setCheckingAnswer(false);
      setSavingAnswer(false);
    }
  }
  /** "I don't know yet": records no answer and no evidence; confidence stays optional. */
  async function abstain(item: Challenge) {
    const chosen = confidence[item.challengeId];
    setSavingAnswer(true);
    try {
      const result = await command("answers", { challengeId: item.challengeId, abstain: true, ...(chosen ? { confidence: chosen } : {}) });
      setNotice({ render: (t) => answerFeedback(result, false, t), tone: answerFeedbackTone(result), answer: true });
    } finally {
      setSavingAnswer(false);
    }
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
  return {
    check: {
      onStart: (assessmentId) => startCheck(assessmentId),
      onAnswer: (item) => run(() => submitAnswer(item)),
      onAbstain: (item) => run(() => abstain(item)),
      onSolution: (item) =>
        run(async () => {
          const result = await command<{ explanation: string }>("solution", { challengeId: item.challengeId });
          setNotice({ render: () => result.explanation });
        }),
      checkingAnswer,
      savingAnswer,
      confidence: challenge ? confidence[challenge.challengeId] ?? null : null,
      onConfidenceChange: (value) => challenge && setConfidence((all) => ({ ...all, [challenge.challengeId]: value })),
      ...(feedback ? { answerFeedback: feedback } : {}),
    },
  };
}
