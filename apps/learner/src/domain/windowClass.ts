import type { LayoutClass } from "@course-core/sdk";

/** Window size classes shared by the public demo and the connected learner.
 *
 * The class follows the *effective* window width (CSS pixels divided by the
 * learner's text scale), never a device label: a phone in landscape, a tablet in
 * split view and a desktop window at 200% zoom all land in the class their
 * usable width supports. They are the SDK's layout classes, reported to the server
 * (platform capabilities), shown as `data-window-class` and in the debug inspector.
 *
 * - compact  (< 600)
 * - medium   (600–839)
 * - expanded (≥ 840)
 *
 * Where the connected learner puts the companion is domain/companionLayout.ts.
 */
export type WindowClass = LayoutClass;
export const MEDIUM_MIN_WIDTH = 600;
export const EXPANDED_MIN_WIDTH = 840;

/** The width the layout uses: CSS pixels over the text scale (a scale below 1 never widens it). */
export function effectiveWidth(width: number, fontScale = 1): number {
  const scale = Number.isFinite(fontScale) && fontScale > 1 ? fontScale : 1;
  return (Number.isFinite(width) ? width : 0) / scale;
}

export function windowClass(width: number, fontScale = 1): WindowClass {
  const effective = effectiveWidth(width, fontScale);
  if (effective < MEDIUM_MIN_WIDTH) return "compact";
  return effective < EXPANDED_MIN_WIDTH ? "medium" : "expanded";
}

/** The public demo (`/demo`, domain/session.ts) keeps its companion beside the lesson only when the
 * window is not compact and at least this high; otherwise in a dialog. */
export const PANE_MIN_HEIGHT = 600;

/** The demo's rule: beside the lesson, or in a sheet. */
export function companionPlacement(
  windowSize: WindowClass,
  height: number,
): "pane" | "sheet" {
  return windowSize !== "compact" && height >= PANE_MIN_HEIGHT
    ? "pane"
    : "sheet";
}
