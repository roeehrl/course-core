import React, { forwardRef } from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { IconName, IconSize } from "../../components/icons/icons";

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title" | "children"> {
  icon: IconName;
  /** The accessible name, also shown as the tooltip. */
  label: string;
  /** A toggle (`aria-pressed`). */
  pressed?: boolean;
  iconSize?: IconSize;
}

/**
 * A round icon-only control: a 36 px hover disc on `--surface-2`, 24 px fine / 44 px coarse
 * target, a 2 px focus outline (primitives.css).
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, pressed, iconSize = 20, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={["cc-ui-icon-button", className].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...props}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
});
