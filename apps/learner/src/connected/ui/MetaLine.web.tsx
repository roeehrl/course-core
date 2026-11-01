import React from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { MetaLineProps } from "./MetaLine";

export type { MetaLineProps } from "./MetaLine";

/** A start-aligned meta line: 16 px icon, muted text, an optional `--line` rule and one action. */
export function MetaLine({ children, icon, rule, action, className }: MetaLineProps) {
  return (
    <div className={["cc-ui-meta", rule ? "has-rule" : "", className].filter(Boolean).join(" ")}>
      {icon && <Icon name={icon} size={16} />}
      <span className="cc-ui-meta-text">{children}</span>
      {rule && <span className="cc-ui-meta-rule" aria-hidden="true" />}
      {action && (
        <button type="button" className="cc-ui-text-button" onClick={action.onPress}>
          {action.label}
        </button>
      )}
    </div>
  );
}
