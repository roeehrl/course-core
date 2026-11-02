import React, { forwardRef } from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { PillButtonProps } from "./PillButton";

export type { PillButtonProps } from "./PillButton";

/** A rounded text button: outline or accent-filled, 32/36/40 px high (44 coarse), optional icons. */
export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(function PillButton(
  { label, onPress, variant = "outline", size = 36, startIcon, endIcon, disabled, className, describedBy },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={["cc-ui-pill", `cc-ui-pill-${variant}`, `cc-ui-pill-${size}`, className].filter(Boolean).join(" ")}
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={onPress}
    >
      {startIcon && <Icon name={startIcon} size={16} />}
      <span>{label}</span>
      {endIcon && <Icon name={endIcon} size={16} />}
    </button>
  );
});
