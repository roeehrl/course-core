import type { Translate } from "../i18n";

/**
 * A learner's name as staff see it. The API sends no name for an enrollment whose learning data
 * was erased, so the admin words it in the reader's language instead of showing server text.
 */
export function learnerName(
  t: Translate,
  enrollment: { status: string; profile: { displayName: string } },
) {
  if (enrollment.status === "erased") return t("learnerName.erased");
  return enrollment.profile.displayName || t("learnerName.unnamed");
}
