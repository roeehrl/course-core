import type { LayoutClass } from "@course-core/sdk";

/** Window size classes shared by the public demo and the connected learner.
 *
 * The class follows the *effective* window width (CSS pixels divided by the
 * learner's text scale), never a device label: a phone in landscape, a tablet in
 * split view and a desktop window at 200% zoom all land in the class their
 * usable width supports.
 *
 * - compact  (< 600): one column; the companion is a full-height sheet.
 * - medium   (600–839): lesson plus a collapsible companion pane.
 * - expanded (≥ 840): lesson plus the companion pane.
 */
export type WindowClass = LayoutClass;
export const MEDIUM_MIN_WIDTH = 600;
export const EXPANDED_MIN_WIDTH = 840;
/** Below this layout height a side pane leaves too little room for the lesson
 * and its action bar (a phone in landscape), so the companion becomes a sheet. */
export const PANE_MIN_HEIGHT = 600;

export function windowClass(width: number, fontScale = 1): WindowClass {
  const scale = Number.isFinite(fontScale) && fontScale > 1 ? fontScale : 1;
  const effective = (Number.isFinite(width) ? width : 0) / scale;
  if (effective < MEDIUM_MIN_WIDTH) return "compact";
  return effective < EXPANDED_MIN_WIDTH ? "medium" : "expanded";
}

/** Where the companion lives for a window: beside the lesson, or in a sheet. */
export function companionPlacement(
  windowSize: WindowClass,
  height: number,
): "pane" | "sheet" {
  return windowSize !== "compact" && height >= PANE_MIN_HEIGHT
    ? "pane"
    : "sheet";
}
