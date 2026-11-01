import React, { useId, useState } from "react";
import { Icon } from "../../components/icons/Icon.web";
import type { NoticeBannerProps } from "./NoticeBanner";

export type { NoticeBannerProps } from "./NoticeBanner";

/**
 * A limitation or detour notice: `--surface-2`, radius 12, a 16 px icon, at most two lines, one
 * text action and an optional ⓘ that opens one more line.
 */
export function NoticeBanner({ text, icon = "info", action, info, className }: NoticeBannerProps) {
  const [more, setMore] = useState(false);
  const extra = useId();
  return (
    <div className={["cc-ui-notice", className].filter(Boolean).join(" ")}>
      <Icon name={icon} size={16} />
      <div className="cc-ui-notice-body">
        <p className="cc-ui-notice-text">{text}</p>
        {info && (
          <p id={extra} className="cc-ui-notice-more" hidden={!more}>
            {info.text}
          </p>
        )}
      </div>
      {info && (
        <button
          type="button"
          className="cc-ui-icon-button is-small"
          aria-label={info.label}
          title={info.label}
          aria-expanded={more}
          aria-controls={extra}
          onClick={() => setMore((value) => !value)}
        >
          <Icon name="info" size={16} />
        </button>
      )}
      {action && (
        <button type="button" className="cc-ui-text-button" onClick={action.onPress}>
          {action.label}
        </button>
      )}
    </div>
  );
}
