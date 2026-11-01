import React from "react";
import type { Challenge, ServerSnapshot } from "../../client/apiClient";
import { useT } from "../../i18n";

/** Whether the open question counts, said before the question. */
export function KindLine({ challenge }: { challenge: Challenge; server?: ServerSnapshot; episodeId?: string; onFreshCheck?: () => void }) {
  const t = useT();
  return (
    <p className={`connected-question-kind ${challenge.independentEligible ? "is-counted" : "is-practice"}`} data-testid="question-kind">
      <strong>{challenge.independentEligible ? t("kindLine.independent") : t("kindLine.practice")}</strong>{" "}
      {challenge.independentEligible ? t("kindLine.independentHint") : t("kindLine.practiceHint")}
    </p>
  );
}
