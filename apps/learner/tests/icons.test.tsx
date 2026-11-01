import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../src/components/icons/Icon.web";
import { ICONS, ICON_NAMES, strokeWidth, type IconName } from "../src/components/icons/icons";

// The icon set (final design §1.4): one decorative inline SVG per icon, a 1.75 px stroke at every
// size, the mirrored set flipped in right-to-left text and never the rest (RTL-4).
const MIRRORED: IconName[] = ["chevron-down", "chevron-up", "chevron-right", "chevron-left", "chevrons-up-down", "arrow-right", "corner-down-left", "external-link", "panel-right"];
const NEVER_MIRRORED: IconName[] = ["arrow-up", "square", "copy", "thumb-up", "thumb-down", "clock", "sparkle", "counts", "practice"];
const SPEC: IconName[] = [
  "sparkle", "counts", "practice", "arrow-up", "square", "clock", "copy", "check", "thumb-up", "thumb-down", "more-horizontal",
  "chevron-down", "chevron-up", "chevrons-up-down", "info", "x", "maximize-2", "panel-right", "book-open", "quote", "code", "image",
  "play", "alert-circle", "rotate-ccw", "arrow-down", "pencil", "trash-2", "bell", "wifi-off", "pause-circle", "lock", "shield-check",
  "eye-off", "lightbulb", "corner-down-left", "arrow-right", "external-link",
];

describe("icons", () => {
  it("has every icon the design names", () => {
    for (const name of SPEC) expect(ICON_NAMES).toContain(name);
  });

  it.each(ICON_NAMES)("%s renders as a decorative SVG", (name) => {
    const { container } = render(<Icon name={name} size={16} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg.querySelectorAll("path, circle, rect").length).toBeGreaterThan(0);
    expect(svg.classList.contains("cc-ui-icon-mirror")).toBe(MIRRORED.includes(name));
  });

  it("mirrors only the set that points along the line", () => {
    for (const name of MIRRORED) expect(ICONS[name].mirror, name).toBe(true);
    for (const name of NEVER_MIRRORED) expect(ICONS[name].mirror, name).toBeFalsy();
  });

  it("draws a 1.75 px stroke at 16, 18 and 20 px", () => {
    for (const size of [16, 18, 20] as const) {
      const { container } = render(<Icon name="arrow-up" size={size} />);
      const svg = container.querySelector("svg")!;
      expect(Number(svg.getAttribute("stroke-width")) * (size / 24)).toBeCloseTo(1.75, 5);
      expect(svg.getAttribute("stroke")).toBe("currentColor");
    }
    expect(strokeWidth(ICONS.counts, 16)).toBe(1.75);
  });

  it("colours the companion glyph and the credit pair from tokens", () => {
    const sparkle = render(<Icon name="sparkle" />).container.querySelector("path")!;
    expect(sparkle.getAttribute("fill")).toBe("var(--companion)");
    const counts = render(<Icon name="counts" size={16} />).container;
    expect(counts.querySelector("circle")!.getAttribute("fill")).toBe("var(--accent)");
    expect(counts.querySelector("path")!.getAttribute("stroke")).toBe("var(--on-accent)");
    const practice = render(<Icon name="practice" size={16} />).container.querySelector("circle")!;
    expect(practice.getAttribute("stroke")).toBe("var(--ink-muted)");
    expect(practice.getAttribute("stroke-dasharray")).toBe("2.5 2");
  });

  it("keeps strokes and fills visible in forced colours, and flips the mirrored set by direction", () => {
    const css = readFileSync(join(__dirname, "../src/connected/ui/primitives.css"), "utf8");
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.cc-ui-icon \{\s*color: CanvasText;/);
    expect(forced).toMatch(/\.cc-ui-icon-practice circle \{\s*stroke: CanvasText;/);
    expect(css).toMatch(/\.cc-ui-icon-mirror:dir\(rtl\) \{\s*transform: scaleX\(-1\);/);
  });
});
