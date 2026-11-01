import { EXPANDED_MIN_WIDTH, MEDIUM_MIN_WIDTH, effectiveWidth, windowClass, type WindowClass } from "./windowClass";

/**
 * Where the companion goes in a window (final design §2), and whether the page uses its compact
 * layout (the lesson scrolls in its own pane under the header).
 *
 * W is the window's width over the learner's text scale; H is the layout height, measured while no
 * editable element has focus (connected/layoutViewport.ts), so an on-screen keyboard never changes
 * the layout.
 *
 * - `docked`: W ≥ 840 and H ≥ 480, a panel at the inline end beside the lesson.
 * - `sheet: "phone"`: W < 600, a full-width bottom sheet.
 * - `sheet: "tablet"`: 600 ≤ W < 840, a bottom sheet `min(640px, 100% - 48px)` wide, centred.
 * - `sheet: "short"`: H < 480 in a window wider than a phone, a sheet at Full (with a 48 px strip)
 *   or Collapsed.
 *
 * `compactPage` is true on phones and short windows (the lesson scrolls in its own pane, so the
 * window never scrolls to a blank page), false beside the panel and on a tablet in portrait, where
 * the window scrolls as usual. `windowClass` keeps the SDK's layout classes (compact < 600,
 * medium < 840, expanded), which the platform report, `data-window-class` and the debug inspector use.
 */
export const DOCKED_MIN_WIDTH = EXPANDED_MIN_WIDTH;
export const DOCKED_MIN_HEIGHT = 480;

export type CompanionSheet = "phone" | "tablet" | "short";
export interface CompanionLayout {
  placement: "docked" | "sheet";
  sheet: CompanionSheet | null;
  compactPage: boolean;
  windowClass: WindowClass;
}

export function companionLayout(width: number, height: number, fontScale = 1): CompanionLayout {
  const size = windowClass(width, fontScale);
  const w = effectiveWidth(width, fontScale);
  const h = Number.isFinite(height) ? height : 0;
  const sheet: CompanionSheet | null =
    w < MEDIUM_MIN_WIDTH ? "phone" : h < DOCKED_MIN_HEIGHT ? "short" : w < DOCKED_MIN_WIDTH ? "tablet" : null;
  return {
    placement: sheet ? "sheet" : "docked",
    sheet,
    compactPage: sheet === "phone" || sheet === "short",
    windowClass: size,
  };
}
