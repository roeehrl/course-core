import type { Challenge } from "../../client/apiClient";
import type { MessageKey, Translate } from "../../i18n";

/** The reasons a practice question names (kindLine `reason.*`, creditCopy `practiceSuffix.*`). A
 * fresh question, a question asked for as practice and older questions name none. */
export const WORDED_REASONS = ["companion", "hint", "solution", "seen_before"] as const;
export type WordedReason = (typeof WORDED_REASONS)[number];

/** The reason a question counts as practice when the app words it, or none. */
export function wordedReason(challenge: Pick<Challenge, "independentEligible" | "practiceReason">): WordedReason | undefined {
  const reason = challenge.independentEligible ? undefined : challenge.practiceReason;
  return (WORDED_REASONS as readonly string[]).includes(reason ?? "") ? (reason as WordedReason) : undefined;
}

/**
 * What feedback on a practice question adds under its verdict (CRD-6): why it counts as practice
 * ("This counts as practice because you asked your companion."). None while it counts, and none
 * when the reason is not known: never a guess.
 */
export function practiceSuffix(challenge: Pick<Challenge, "independentEligible" | "practiceReason">, t: Translate): string | undefined {
  const reason = wordedReason(challenge);
  return reason ? t(`creditCopy.practiceSuffix.${reason}` as MessageKey) : undefined;
}
