import React from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { companionBridge, useCompanionActivity } from "../companion/bridge";
import { useCompanionOpenValue } from "../companion/openState";

/**
 * One line at the end of a check while the companion is closed and its reply about this question
 * has settled unseen: "Your companion replied about this question." with "Open", which opens the
 * companion at that reply. It goes once the reply is seen (the unread tracker drops it) or while
 * the companion is open.
 */
export function ReplyNudge({ challengeId }: { challengeId: string | undefined }) {
  const t = useT();
  const replyId = useCompanionActivity().replyAbout[challengeId ?? ""];
  const open = useCompanionOpenValue("open");
  if (!challengeId || !replyId || open) return null;
  return (
    <p className="cc-check-nudge">
      <Icon name="sparkle" size={16} />
      <span>{t("replyNudge.text")}</span>
      <button type="button" className="cc-ui-text-button" onClick={() => companionBridge.compose({ source: "nudge", revealMessageId: replyId })}>
        {t("replyNudge.open")}
      </button>
    </p>
  );
}
