import React, { forwardRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Icon } from "../../components/icons/Icon.web";
import { useCompanionActivity } from "./bridge";
import { shortcutAria, shortcutLabel } from "./shortcut";

/**
 * The button that opens and closes the companion (final design §3.1). It sits in the app header on
 * every window class: a 44 px pill with the companion glyph and "Companion" (a 44 px circle with
 * the glyph only under 360 px). While the companion shows it is pressed (`aria-expanded`), and a
 * press closes it. A dot at its top inline-end corner marks replies the learner has not seen (or a
 * suggestion waiting on the profile), and its name says so. It never says it opens a dialog: the
 * sheet is never one. Without a header slot it floats at the window's bottom inline-end corner.
 */
export const CompanionTrigger = forwardRef<
  HTMLButtonElement,
  { open: boolean; slot: HTMLElement | null; onToggle: () => void }
>(function CompanionTrigger({ open, slot, onToggle }, ref) {
  const t = useT();
  const { unread, suggestions } = useCompanionActivity();
  const name =
    unread > 0
      ? t("companionTrigger.unread", { count: unread })
      : suggestions > 0
        ? t("companionTrigger.suggestion")
        : t("companionTrigger.name");
  const button = (
    <button
      ref={ref}
      type="button"
      className={["connected-companion-trigger", slot ? "is-in-header" : "is-floating", unread > 0 || suggestions > 0 ? "has-dot" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-label={name}
      aria-expanded={open}
      aria-controls="connected-companion"
      aria-keyshortcuts={shortcutAria()}
      title={open ? t("companionDock.close") : t("companionTrigger.tooltip", { keys: shortcutLabel() })}
      data-usability="detour"
      onClick={onToggle}
    >
      <Icon name="sparkle" size={18} />
      <span className="cc-shell-trigger-label">{t("companionTrigger.name")}</span>
      {(unread > 0 || suggestions > 0) && <span className="cc-shell-trigger-dot" aria-hidden="true" />}
    </button>
  );
  return slot ? createPortal(button, slot) : button;
});
