import React, { useEffect, useState } from "react";
import type { Challenge } from "../../client/apiClient";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Icon } from "../../components/icons/Icon.web";
import { courseContentAttributes } from "../../domain/contentLanguage";
import { useT } from "../../i18n";
import { answerResult, type AnswerResult } from "../answerFeedback";
import { practiceSuffix } from "../credit/creditCopy";
import { PreparingDots } from "../ui/PreparingDots.web";
import { StatusLine } from "../ui/StatusLine.web";
import type { CheckAttempt } from "./useCheckCommands";

/** The three dots of a grader wait appear only once it lasts (§4.1): a quick answer shows none. */
export const GRADER_DOTS_AFTER_MS = 400;

/** The verdict line's icon: a check for a pass, "revisit" for an answer to work on, none else. */
const VERDICT_ICON: Partial<Record<AnswerResult["verdict"], "check" | "rotate-ccw">> = {
  correct: "check",
  codePassed: "check",
  revisit: "rotate-ccw",
  codeFailed: "rotate-ccw",
};

/**
 * What the check says about the answer just sent, in place under the question (TUT-7): no box, a
 * verdict line, the explanation in Markdown (math renders), and on a practice answer why it is
 * practice. While the grader works it shows three dots; when it could not check, one line with a
 * retry. The caller renders it inside the check's status region, so it is announced once, at the
 * end; the dots are not announced.
 */
export function CheckFeedback({ attempt, course, onRetry }: { attempt: CheckAttempt; course?: unknown; onRetry: () => void }) {
  const t = useT();
  const [waited, setWaited] = useState(false);
  const checking = attempt.status === "checking";
  useEffect(() => {
    setWaited(false);
    if (!checking) return;
    const timer = setTimeout(() => setWaited(true), GRADER_DOTS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [checking]);
  if (checking) return waited ? <PreparingDots className="cc-check-dots" /> : null;
  if (attempt.status === "failed")
    return (
      <div className="cc-check-feedback">
        <StatusLine className="cc-check-failed" tone="error" text={t("checkFeedback.graderFailed")} />
        <button type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-check-retry" onClick={onRetry}>
          {t("checkFeedback.tryAgain")}
        </button>
      </div>
    );
  const result = answerResult(attempt.receipt, attempt.code, t);
  if (result.verdict === "abstained")
    return (
      <div className="cc-check-feedback">
        <p className="cc-check-noted">{t("checkFeedback.abstained")}</p>
      </div>
    );
  const icon = VERDICT_ICON[result.verdict];
  const suffix = result.independent ? undefined : practiceSuffix({ ...attempt.challenge, independentEligible: false } as Challenge, t);
  return (
    <div className="cc-check-feedback">
      <p className="cc-check-verdict" data-verdict={result.verdict}>
        {icon && <Icon name={icon} size={20} className={`cc-check-verdict-icon is-${icon}`} />}
        <span>{t(`answerFeedback.verdict.${result.verdict}`)}</span>
      </p>
      {result.explanation && (
        // An author's explanation is course text, in the course's language; Core's coded line is ours.
        <div className="cc-check-explanation" {...(result.coded ? {} : courseContentAttributes(course))}>
          <MarkdownContent markdown={result.explanation} />
        </div>
      )}
      {suffix && <p className="cc-check-suffix">{suffix}</p>}
    </div>
  );
}
