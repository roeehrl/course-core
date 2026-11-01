import type { Challenge } from "../../client/apiClient";
import type { Translate } from "../../i18n";

/** What feedback on a question adds when it counts as practice: today's generic wording. */
export function practiceSuffix(challenge: Pick<Challenge, "independentEligible">, t: Translate): string | undefined {
  return challenge.independentEligible ? undefined : t("creditCopy.practiceSuffix");
}
