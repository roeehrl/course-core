import React from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { StatusLineProps } from "./StatusLine";

export type { StatusLineProps } from "./StatusLine";

/** One status sentence: icon, text and at most one action (13/20, 14/22 in Hebrew). */
export function StatusLine({ text, tone = "muted", icon, action, className }: StatusLineProps) {
  const glyph = icon ?? (tone === "error" ? "alert-circle" : undefined);
  return (
    <p className={["cc-ui-status", `is-${tone}`, className].filter(Boolean).join(" ")}>
      {glyph && <Icon name={glyph} size={16} />}
      <span className="cc-ui-status-text">{text}</span>
      {action && (
        <button type="button" className="cc-ui-text-button" onClick={action.onPress}>
          {action.label}
        </button>
      )}
    </p>
  );
}
