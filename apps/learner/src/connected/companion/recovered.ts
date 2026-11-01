import type { Translate } from "../../i18n";

/**
 * A companion message saved on this device before a reload or a lost connection, recovered and
 * sent when the page loaded again: said once, so the learner looks before asking again.
 */
export function recoveredCompanionRequest({ setNotice }: { setNotice: (notice: { render: (t: Translate) => string }) => void }) {
  setNotice({ render: (t) => t("recovered.recoveredMessage") });
}
