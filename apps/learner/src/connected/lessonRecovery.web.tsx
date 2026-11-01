import React, { useEffect, useState } from "react";
import { Button } from "../components/ui";
import { useT } from "../i18n";

/** A fresh check the lesson plans after the questions ran out of what they can show. */
export function FreshCheckButton({ minutes, disabled, onPress }: { minutes: number; disabled: boolean; onPress: () => void }) {
  const t = useT();
  return <Button label={t("lessonRecovery.fresh", { minutes })} kind="primary" usability="next" disabled={disabled} onPress={onPress} />;
}

/**
 * A lesson that needs another independent question while none is left: said plainly, and the
 * course team is told (once per lesson and course version, by the server) instead of leaving the
 * learner at a dead end.
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
      <p><strong>{t("lessonRecovery.exhausted")}</strong></p>
      <p>{t(told === "told" ? "lessonRecovery.exhaustedTold" : told === "telling" ? "lessonRecovery.exhaustedTelling" : "lessonRecovery.exhaustedNotTold")}</p>
    </div>
  );
}
