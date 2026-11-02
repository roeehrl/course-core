import React, { useRef, useSyncExternalStore } from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import { companionFocus } from "../../client/companionFocus";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { CreditInfo } from "./CreditInfo.web";
import { scopedQuestion } from "./creditScope";

/** The id the credit line renders with, for the composer's `aria-describedby`. */
export const CREDIT_LINE_ID = "cc-credit-line";

/** The check attached to the next message, if any (companionFocus.ts). */
export function useAttachedCheckId(): string | undefined {
  return useSyncExternalStore(companionFocus.subscribe, () => companionFocus.get().check?.challengeId, () => undefined);
}

/**
 * The credit line (final design §3.11, "before"): while an open counted question is in the scope
 * of the next message, the Practice icon, "Question 1 counts. Asking now makes it practice." (with
 * several in scope, "2 questions count. Asking now makes them practice.") and an ⓘ with how questions count. It sits in the notice slot above the composer; when a limitation
 * banner takes that slot it moves to the meta line under it (`placement: "meta"`), never dropped.
 * Quiet: no fill, no warning colour (CRD-8).
 */
export function CreditNotice({
  server,
  episodeId,
  now,
  placement,
}: {
  server?: ServerSnapshot;
  episodeId?: string;
  now: number;
  placement: "notice" | "meta";
}) {
  const t = useT();
  const line = useRef<HTMLDivElement>(null);
  const attached = useAttachedCheckId();
  const question = scopedQuestion(server, episodeId, now, attached);
  if (!question) return null;
  return (
    <div ref={line} className={`cc-credit-line is-${placement}`} data-testid="credit-line">
      <Icon name="practice" size={16} className="cc-credit-line-icon" />
      <p id={CREDIT_LINE_ID} className="cc-credit-line-text">
        {question.count > 1 ? t("creditNotice.lineMany", { count: question.count }) : t("creditNotice.line", { ordinal: question.ordinal })}
      </p>
      <CreditInfo line={line} />
    </div>
  );
}

/** Whether the credit line shows for these inputs (the composer's `aria-describedby`). */
export function useCreditLineShown(server: ServerSnapshot | undefined, episodeId: string | undefined, now: number): boolean {
  return Boolean(scopedQuestion(server, episodeId, now, useAttachedCheckId()));
}
