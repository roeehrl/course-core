import React from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";

/**
 * Jump to latest (final design §3.8, M13): a 36 px circle (44 coarse) centred 12 px above the
 * composer zone while the end of the conversation is below the view, with an accent dot once
 * something new arrived there.
 */
export function JumpToLatest({ visible, dot, onJump }: { visible: boolean; dot: boolean; onJump(): void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="cc-chat-jump"
      data-visible={visible ? "true" : "false"}
      tabIndex={visible ? undefined : -1}
      aria-hidden={visible ? undefined : true}
      aria-label={t("jumpToLatest.label")}
      title={t("jumpToLatest.label")}
      onClick={onJump}
    >
      <Icon name="arrow-down" size={20} />
      {dot && <span className="cc-chat-jump-dot" aria-hidden="true" />}
    </button>
  );
}
