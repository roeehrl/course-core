import React, { useId } from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import type { ChipProps } from "./Chip";

export type { ChipProps } from "./Chip";

/** A chip, 28 or 32 px high (44 coarse), 1 px `--line-strong`, radius 999 (final design §3.6). */
export function Chip({ label, variant = "send", onPress, onRemove, removeLabel, icon, size = 32, className }: ChipProps) {
  const t = useT();
  const hint = useId();
  const classes = ["cc-ui-chip", `is-${variant}`, `is-${size}`, className].filter(Boolean).join(" ");
  if (variant === "removable")
    return (
      <span className={classes}>
        {icon && <Icon name={icon} size={16} />}
        <span className="cc-ui-chip-label">{label}</span>
        {onRemove && (
          <button type="button" className="cc-ui-chip-remove" aria-label={removeLabel} title={removeLabel} onClick={onRemove}>
            <Icon name="x" size={16} />
          </button>
        )}
      </span>
    );
  return (
    <button type="button" className={classes} onClick={onPress} aria-describedby={variant === "fill" ? hint : undefined}>
      {variant === "fill" ? <Icon name={icon ?? "pencil"} size={16} /> : icon ? <Icon name={icon} size={16} /> : null}
      <span className="cc-ui-chip-label">{label}</span>
      {variant === "fill" && (
        <span id={hint} hidden>
          {t("chip.fillsIn")}
        </span>
      )}
    </button>
  );
}
