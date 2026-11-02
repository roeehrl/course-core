import React from "react";
import { ICONS, strokeWidth, type IconDefinition, type IconNode } from "./icons";
import type { IconProps } from "./Icon";

export type { IconProps } from "./Icon";

const FILLS: Record<NonNullable<IconDefinition["paint"]>, (index: number) => React.SVGProps<SVGElement>> = {
  sparkle: () => ({ fill: "var(--companion)", stroke: "none" }),
  // Counts: the filled circle, then the check mark on it.
  counts: (index) => (index === 0 ? { fill: "var(--accent)", stroke: "none" } : { fill: "none", stroke: "var(--on-accent)" }),
  practice: () => ({ fill: "none", stroke: "var(--ink-muted)" }),
};

function node([tag, attributes]: IconNode, key: number, extra: React.SVGProps<SVGElement>) {
  return React.createElement(tag, { key, ...attributes, ...extra });
}

/**
 * One icon as inline SVG (final design §1.4). Always decorative (`aria-hidden`): the control or
 * line it sits in carries the words. Strokes use `currentColor`, so an icon takes its text's
 * colour, and forced colours keep it visible (primitives.css). Icons that point along the line
 * get `cc-ui-icon-mirror`, which flips them in right-to-left text.
 */
export function Icon({ name, size = 20, className, style }: IconProps) {
  const icon = ICONS[name];
  const width = strokeWidth(icon, size);
  const scale = icon.grid / size;
  const classes = ["cc-ui-icon", icon.mirror ? "cc-ui-icon-mirror" : "", icon.paint ? `cc-ui-icon-${icon.paint}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={classes}
      data-icon={name}
      width={size}
      height={size}
      viewBox={`0 0 ${icon.grid} ${icon.grid}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none", ...style }}
    >
      {icon.nodes.map((item, index) =>
        node(
          item,
          index,
          icon.paint === "practice"
            ? { ...FILLS.practice(index), strokeDasharray: `${2.5 * scale} ${2 * scale}` }
            : icon.paint
              ? FILLS[icon.paint](index)
              : {},
        ),
      )}
    </svg>
  );
}
