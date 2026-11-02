import React, { useEffect, useState } from "react";
import { Icon } from "../components/icons/Icon.web";
import { useT } from "../i18n";
import { PreparingDots } from "./ui/PreparingDots.web";

/** A fresh check the lesson plans after the questions ran out of what they can show: an outline
 * pill with the time it takes and a forward arrow (§4.18). */
export function FreshCheckButton({ minutes, disabled, onPress }: { minutes: number; disabled: boolean; onPress: () => void }) {
  const t = useT();
  return (
    <button type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-40 cc-ai-fresh-check" data-usability="next" disabled={disabled} onClick={onPress}>
      <span>{t("lessonRecovery.fresh", { minutes })}</span>
      <Icon name="arrow-right" size={16} />
    </button>
  );
}

/**
 * A lesson that needs another independent question while none is left: said plainly, in place
 * under the check, and the course team is told (once per lesson and course version, by the server)
 * instead of leaving the learner at a dead end. The line under it says whether they were told.
 */
export function QuestionsExhausted({ episodeId, onReport }: { episodeId: string; onReport: ((episodeId: string) => Promise<boolean>) | undefined }) {
  const t = useT();
  const [told, setTold] = useState<"telling" | "told" | "failed">("telling");
  useEffect(() => {
    if (!onReport) return setTold("failed");
    let live = true;
    setTold("telling");
    onReport(episodeId).then((ok) => live && setTold(ok ? "told" : "failed"), () => live && setTold("failed"));
    return () => {
      live = false;
    };
  }, [episodeId, onReport]);
  return (
    <div className="connected-questions-exhausted" role="status" data-testid="questions-exhausted">
      <p className="cc-ai-exhausted-title">{t("lessonRecovery.exhausted")}</p>
      <p className={told === "failed" ? "cc-ui-status is-error cc-ai-exhausted-team" : "cc-ui-status cc-ai-exhausted-team"} data-state={told}>
        {told === "telling" ? <PreparingDots /> : <Icon name={told === "told" ? "check" : "alert-circle"} size={16} />}
        <span>{t(told === "told" ? "lessonRecovery.exhaustedTold" : told === "telling" ? "lessonRecovery.exhaustedTelling" : "lessonRecovery.exhaustedNotTold")}</span>
      </p>
    </div>
  );
}
