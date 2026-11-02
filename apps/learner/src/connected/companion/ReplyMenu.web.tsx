import React from "react";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { Menu, type MenuItem } from "../ui/Menu.web";

/**
 * More (`more-horizontal`) in a companion reply's action row (final design §3.7): whether later
 * answers may use the reply ("Don't use in later answers" ⇄ "Use in later answers again"),
 * "Report a problem", and under a hint that stood in for an answer, "Based on…" (§3.12). A
 * keyboard menu: ↑/↓, Home and End move, Esc closes it and returns focus to More.
 */
export function ReplyMenu({ excluded, saving, reported, onExclude, onReport, onBasedOn }: {
  /** Later answers do not use this reply. */
  excluded: boolean;
  /** A change to its use is being saved. */
  saving?: boolean;
  /** The learner already reported a problem with it. */
  reported?: boolean;
  onExclude?: (excluded: boolean) => void;
  onReport?: () => void;
  /** Opens what the reply was based on (only when its chip is not in the row). */
  onBasedOn?: () => void;
}) {
  const t = useT();
  const items: MenuItem[] = [];
  if (onExclude)
    items.push({
      id: "use",
      label: t(excluded ? "replyMenu.include" : "replyMenu.exclude"),
      icon: "eye-off",
      disabled: saving,
      onSelect: () => onExclude(!excluded),
    });
  if (onReport) items.push({ id: "report", label: t("replyMenu.report"), icon: "alert-circle", disabled: reported, onSelect: onReport });
  if (onBasedOn) items.push({ id: "based", label: t("replyMenu.basedOn"), icon: "info", onSelect: onBasedOn });
  if (!items.length) return null;
  return (
    <Menu
      label={t("replyMenu.label")}
      items={items}
      align="start"
      className="cc-act-menu"
      trigger={(props) => <IconButton icon="more-horizontal" iconSize={16} label={t("replyMenu.more")} className="cc-act-icon" {...props} />}
    />
  );
}
