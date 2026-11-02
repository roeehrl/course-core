import React from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { TagProps } from "./Tag";

export type { TagProps } from "./Tag";

/** A small pill naming a state (12/16, 13/18 in Hebrew). */
export function Tag({ label, variant = "muted", icon, className }: TagProps) {
  return (
    <span className={["cc-ui-tag", `is-${variant}`, className].filter(Boolean).join(" ")}>
      {icon && <Icon name={icon} size={16} />}
      {label}
    </span>
  );
}
