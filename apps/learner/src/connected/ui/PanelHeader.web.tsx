import React from "react";
import { Icon } from "../../components/icons/Icon.web";

/**
 * A companion panel's head: the glyph, the title (with an optional muted subtitle) and an end slot
 * for its controls. The heading level is the surface's (2 for the panel, sheet and focus view).
 */
export function PanelHeader({
  title,
  subtitle,
  glyph = <Icon name="sparkle" size={20} />,
  end,
  level = 2,
  titleId,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  glyph?: React.ReactNode;
  end?: React.ReactNode;
  level?: 2 | 3;
  titleId?: string;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={["cc-ui-panel-header", className].filter(Boolean).join(" ")}>
      <span className="cc-ui-panel-glyph">{glyph}</span>
      <div className="cc-ui-panel-titles">
        <Heading id={titleId} className="cc-ui-panel-title">
          {title}
        </Heading>
        {subtitle && <p className="cc-ui-panel-subtitle">{subtitle}</p>}
      </div>
      {end && <div className="cc-ui-panel-end">{end}</div>}
    </div>
  );
}
