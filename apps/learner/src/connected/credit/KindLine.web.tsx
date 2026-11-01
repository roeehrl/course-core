import React from "react";
import type { Challenge, ServerSnapshot } from "../../client/apiClient";
import { Icon } from "../../components/icons/Icon.web";
import { useI18n, type MessageKey } from "../../i18n";
import { PillButton } from "../ui/PillButton.web";
import { wordedReason } from "./creditCopy";

const strong = (children: React.ReactNode, key: string) => <strong key={key}>{children}</strong>;

/**
 * Whether the open question counts, said at the top of the check (final design §3.11, §4.1): the
 * Counts icon and "Counts toward this lesson. Answer on your own.", or the Practice icon and
 * "**Practice.** This question does not count toward finishing the lesson." A practice question
 * adds why (the reason line, when the server recorded one) and, while the lesson still needs
 * answers on your own, the path back to a fresh check. Neutral colours; the icons differ by shape.
 */
export function KindLine({
  challenge,
  server,
  episodeId,
  onFreshCheck,
  pending,
}: {
  challenge: Challenge;
  server?: ServerSnapshot;
  episodeId?: string;
  /** Starts a fresh counted check; without it the path back is not offered. */
  onFreshCheck?: () => void;
  pending?: boolean;
}) {
  const i18n = useI18n();
  const counted = challenge.independentEligible;
  const reason = wordedReason(challenge);
  const lesson = episodeId ?? challenge.episodeId;
  const gate = server?.lessons.find((row) => row.id === lesson)?.gate;
  // The lesson still needs answers on your own: a fresh check can count where this one cannot.
  const needsOwn = Boolean(gate && !gate.passed && gate.objectives.some((objective) => !objective.passed));
  const recovery = server?.recovery?.find((row) => row.episodeId === lesson);
  // No question is left to give (the check card says so): no fresh check is ready, so none is offered.
  const exhausted = Boolean(recovery && !recovery.freshCheck);
  const minutes = recovery?.freshCheck?.plannedMinutes;
  return (
    <div className={`cc-credit-kind ${counted ? "is-counted" : "is-practice"}`}>
      <div className="cc-credit-kind-head">
        <Icon name={counted ? "counts" : "practice"} size={16} className="cc-credit-kind-icon" />
        <p className="cc-credit-kind-text" data-testid="question-kind">
          {counted ? i18n.t("kindLine.counted") : i18n.rich("kindLine.practice", undefined, { b: strong })}
        </p>
      </div>
      {!counted && reason && <p className="cc-credit-kind-reason">{i18n.t(`kindLine.reason.${reason}` as MessageKey)}</p>}
      {!counted && needsOwn && !exhausted && onFreshCheck && (
        <div className="cc-credit-kind-back">
          <p className="cc-credit-kind-back-text">{i18n.t("kindLine.pathBack")}</p>
          <PillButton
            size={32}
            label={minutes !== undefined ? i18n.t("kindLine.fresh", { minutes }) : i18n.t("kindLine.freshAnyTime")}
            endIcon="arrow-right"
            disabled={pending}
            onPress={onFreshCheck}
            className="cc-credit-fresh"
          />
        </div>
      )}
    </div>
  );
}
